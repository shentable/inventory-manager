package com.sandwich.inventory

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.net.wifi.WifiManager
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicBoolean

/** 同时监督 EasyTier 与可选 Rust 后端的统一前台服务。 */
class NodeService : Service() {
    companion object {
        private const val TAG = "NodeService"
        private const val ACTION_START = "com.sandwich.inventory.node.START"
        private const val ACTION_STOP = "com.sandwich.inventory.node.STOP"
        private const val ACTION_AVAILABLE = "com.sandwich.inventory.node.AVAILABLE"
        private const val ACTION_SYNC_DDNS = "com.sandwich.inventory.node.SYNC_DDNS"
        private const val CHANNEL_ID = "store_node"
        private const val NOTIFICATION_ID = 42
        private const val EXTRA_NAME = "network_name"
        private const val EXTRA_SECRET = "network_secret"
        fun start(context: Context, cfg: EasyTierCore.Config) {
            val i=Intent(context,NodeService::class.java).setAction(ACTION_START)
                .putExtra(EXTRA_NAME,cfg.networkName).putExtra(EXTRA_SECRET,cfg.networkSecret)
            if(Build.VERSION.SDK_INT>=26) context.startForegroundService(i) else context.startService(i)
        }
        fun stop(context: Context)=context.stopService(Intent(context,NodeService::class.java))
        fun markAvailable(context: Context)=context.startService(Intent(context,NodeService::class.java).setAction(ACTION_AVAILABLE))
        fun syncCloudflareDdns(context: Context)=context.startService(
            Intent(context,NodeService::class.java).setAction(ACTION_SYNC_DDNS),
        )
    }
    private val handler=Handler(Looper.getMainLooper())
    private var easyTier:Process?=null
    private var backend:Process?=null
    private var cfg:EasyTierCore.Config?=null
    private var runningConfig:EasyTierCore.Config?=null
    private var runningPublicTls=false
    private var lastStartElapsed=0L
    private var generation=0
    private var wakeLock:PowerManager.WakeLock?=null
    private var wifiLock:WifiManager.WifiLock?=null
    private val ddnsSyncing=AtomicBoolean(false)

    override fun onBind(intent:Intent?):IBinder?=null
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int{
        when(intent?.action){
            ACTION_STOP->{stopChildren();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();return START_NOT_STICKY}
            ACTION_AVAILABLE->notifyState(getString(R.string.notify_state_available),getString(R.string.notify_state_available_detail))
            ACTION_SYNC_DDNS->triggerCloudflareDdns()
            ACTION_START->{cfg=EasyTierHelper.getConfig(this);startChildren();triggerCloudflareDdns()}
            null->{if(NodeConfig.shouldResume(this)){cfg=EasyTierHelper.getConfig(this);startChildren()}}
        }
        return START_STICKY
    }
    @Synchronized private fun startChildren(force:Boolean=false){
        val config=cfg?:return
        val wantedPublicTls=NativeServerCore.publicTlsEnabled(this)
        val childrenAlive=easyTier?.isAlive==true&&(!config.serverMode||backend?.isAlive==true)
        val stillStarting=SystemClock.elapsedRealtime()-lastStartElapsed<2_000
        if(!force&&runningConfig==config&&runningPublicTls==wantedPublicTls&&(childrenAlive||stillStarting)){
            Log.i(TAG,"node children already running; ignoring duplicate start")
            return
        }
        if(config.serverMode&&backend==null&&HealthProbe.checkOnce(this,"http://${config.virtualIp}:8000",config.socksPort).ok){
            notifyState(getString(R.string.notify_state_conflict),getString(R.string.notify_state_conflict_detail,config.virtualIp))
            Log.e(TAG,"refusing server mode: virtual address is already serving /api/health")
            return
        }
        stopChildren(); runningConfig=config;runningPublicTls=wantedPublicTls;lastStartElapsed=SystemClock.elapsedRealtime();val run=++generation
        if(NodeConfig.mode(this)==NodeMode.SERVER){
            wakeLock=(getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"sandwich:store-host").apply{acquire()}
            wifiLock=(applicationContext.getSystemService(WIFI_SERVICE) as WifiManager)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF,"sandwich:store-host").apply{acquire()}
            notifyState(getString(R.string.notify_state_starting),getString(if(wantedPublicTls)R.string.notify_starting_public_tls else R.string.notify_starting_backend))
            supervise("native-backend",run,{NativeServerCore.start(this)}){backend=it}
            scheduleBackupCheck(run)
            scheduleCloudflareDdns(run, immediate = true)
        }else notifyState(getString(R.string.notify_state_connecting),getString(R.string.notify_connecting_detail))
        supervise("easytier-core",run,{EasyTierCore.start(this,config)}){easyTier=it}
        monitorHealth(run,config)
    }
    private fun supervise(name:String,run:Int,launch:()->Process,set:(Process?)->Unit){
        try {
            val p=launch();set(p)
            // 日志管道可能因厂商系统的 FD 继承而迟迟不 EOF，不能让它阻塞退出监督。
            Thread {
                try {
                    p.inputStream.bufferedReader().useLines { lines ->
                        lines.forEach { Log.i(TAG,"$name: $it") }
                    }
                } catch (e:Exception) {
                    Log.w(TAG,"$name output stream closed",e)
                }
            }.apply{isDaemon=true;this.start()}
            Thread {
                val code=runCatching { p.waitFor() }.getOrDefault(-1)
                if(run==generation)set(null)
                if(run==generation&&cfg!=null){
                    Log.w(TAG,"$name exited $code; restarting")
                    handler.postDelayed({if(run==generation)startChildren(true)},backoff(code))
                }
            }.apply{isDaemon=true;this.start()}
        } catch(e:Exception) {
            set(null)
            Log.e(TAG,"$name start failed",e)
            if(run==generation)handler.postDelayed({if(run==generation)startChildren(true)},2_000)
        }
    }
    private fun backoff(code:Int)=minOf(30_000L,if(code==0)1_000L else 4_000L)
    private fun monitorHealth(run:Int,config:EasyTierCore.Config){Thread{
        var wasHealthy=false
        var consecutiveFailures=0
        var tunnelWasHealthy=false
        var tunnelFailures=0
        while(run==generation){
            val url=if(config.serverMode)NodeConfig.LOCAL_SERVER_URL else NodeConfig.clientServerUrl(this)
            val proxy=if(config.serverMode)null else config.socksPort
            val health=HealthProbe.checkOnce(this,url,proxy)
            val trustedStore=if(config.serverMode)null else NodeConfig.trustedStoreId(this)
            val backendHealthy=health.ok&&(trustedStore==null||trustedStore==health.storeId)
            val tunnelHealthy=HealthProbe.isTcpPortOpen("127.0.0.1",config.socksPort)
            val publicTlsHealthy=!runningPublicTls||HealthProbe.isTcpPortOpen("::1",NativeServerCore.publicHttpsPort(this))
            if(tunnelHealthy){tunnelWasHealthy=true;tunnelFailures=0}
            else if(tunnelWasHealthy)tunnelFailures++
            if(tunnelWasHealthy&&tunnelFailures>=3){
                Log.w(TAG,"EasyTier SOCKS5 health lost; restarting node children")
                handler.post{if(run==generation)startChildren(true)}
                return@Thread
            }
            if(backendHealthy&&tunnelHealthy&&publicTlsHealthy){
                consecutiveFailures=0
                if(!wasHealthy)notifyState(getString(R.string.notify_state_available),getString(if(config.serverMode&&runningPublicTls)R.string.notify_running_full else if(config.serverMode)R.string.notify_running_server else R.string.notify_running_client))
                wasHealthy=true
            }else{
                consecutiveFailures++
                if(config.serverMode&&wasHealthy&&consecutiveFailures>=3){
                    Log.w(TAG,"native backend health lost; restarting node children")
                    handler.post{if(run==generation)startChildren(true)}
                    return@Thread
                }
            }
            Thread.sleep(1_000)
        }
    }.apply{isDaemon=true;start()}}
    private fun scheduleBackupCheck(run:Int){
        if(BackupCoordinator.due(this)) BackupCoordinator.create(this,true){ok,msg->if(!ok)notifyState(getString(R.string.notify_backup_failed),msg)}
        handler.postDelayed({if(run==generation&&NodeConfig.mode(this)==NodeMode.SERVER)scheduleBackupCheck(run)},60*60*1000L)
    }
    private fun scheduleCloudflareDdns(run:Int, immediate:Boolean=false){
        val delay=if(immediate)0L else 5*60*1000L
        handler.postDelayed({
            if(run!=generation||NodeConfig.mode(this)!=NodeMode.SERVER)return@postDelayed
            triggerCloudflareDdns {
                if(run==generation)handler.post{scheduleCloudflareDdns(run)}
            }
        },delay)
    }
    private fun triggerCloudflareDdns(after:(()->Unit)?=null){
        if(NodeConfig.mode(this)!=NodeMode.SERVER){after?.invoke();return}
        if(!ddnsSyncing.compareAndSet(false,true)){after?.invoke();return}
        Thread {
            try {
                val result=CloudflareDdns.syncNow(this)
                if(!result.ok) {
                    Log.w(TAG,result.message)
                    notifyState(getString(R.string.notify_ddns_failed),result.message)
                } else Log.i(TAG,"Cloudflare DDNS: ${result.message}; ${result.ip.orEmpty()}")
            } finally {
                ddnsSyncing.set(false)
                after?.invoke()
            }
        }.apply{isDaemon=true;start()}
    }
    @Synchronized private fun stopChildren(){generation++;runningConfig=null;runningPublicTls=false;lastStartElapsed=0;handler.removeCallbacksAndMessages(null);easyTier?.destroy();backend?.destroy();easyTier=null;backend=null;wakeLock?.let{if(it.isHeld)it.release()};wakeLock=null;wifiLock?.let{if(it.isHeld)it.release()};wifiLock=null}
    override fun onDestroy(){stopChildren();super.onDestroy()}
    private fun notifyState(title:String,text:String){
        if(Build.VERSION.SDK_INT>=26)getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL_ID,getString(R.string.notify_channel_name),NotificationManager.IMPORTANCE_LOW))
        val n:Notification=NotificationCompat.Builder(this,CHANNEL_ID).setSmallIcon(R.drawable.ic_launcher_foreground).setContentTitle(title).setContentText(text).setOngoing(true).build()
        if(Build.VERSION.SDK_INT>=34)startForeground(NOTIFICATION_ID,n,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)else startForeground(NOTIFICATION_ID,n)
    }
}
