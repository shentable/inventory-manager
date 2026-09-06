package com.sandwich.inventory

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

object BackupCoordinator {
    private const val TAG="BackupCoordinator"
    fun due(context:Context)=System.currentTimeMillis()-NodeConfig.lastBackup(context)>=24*60*60*1000L
    fun create(context:Context,automatic:Boolean,done:(Boolean,String)->Unit={_,_->}){
        Thread{runCatching{
            val tree=NodeConfig.backupTree(context)?.let(Uri::parse)?:error(context.getString(R.string.backup_no_directory))
            val pass=NativeServerCore.recoveryPassphrase(context)?:error(context.getString(R.string.backup_no_passphrase))
            val stamp=LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));val prefix=if(automatic)"auto" else "manual"
            val local=File(context.cacheDir,"$prefix-$stamp.swinv.age")
            val exe=File(context.applicationInfo.nativeLibraryDir,NativeServerCore.LIB_NAME)
            val p=ProcessBuilder(exe.absolutePath,"backup","--db",NativeServerCore.database(context).absolutePath,"--output",local.absolutePath).redirectErrorStream(true).apply{environment()["SANDWICH_RECOVERY_PASSPHRASE"]=pass}.start()
            val output=p.inputStream.bufferedReader().readText();check(p.waitFor()==0){output}
            val root=DocumentFile.fromTreeUri(context,tree)?:error(context.getString(R.string.backup_dir_permission_lost))
            val target=root.createFile("application/octet-stream",local.name)?:error(context.getString(R.string.backup_create_failed))
            context.contentResolver.openOutputStream(target.uri,"w")!!.use{out->local.inputStream().use{it.copyTo(out)}}
            if(automatic)root.listFiles().filter{it.name?.startsWith("auto-")==true&&it.name?.endsWith(".swinv.age")==true}.sortedByDescending{it.name}.drop(14).forEach{it.delete()}
            NodeConfig.markBackup(context);local.delete();context.getString(R.string.backup_done_to,target.name)
        }.fold(onSuccess={done(true,it)},onFailure={Log.e(TAG,"backup failed",it);done(false,it.message?:context.getString(R.string.backup_failed))} )}.start()
    }
    fun restore(context:Context,input:Uri,done:(Boolean,String)->Unit){
        Thread{runCatching{
            val pass=NativeServerCore.recoveryPassphrase(context)?:error(context.getString(R.string.backup_no_passphrase))
            val local=File(context.cacheDir,"restore.swinv.age")
            context.contentResolver.openInputStream(input)!!.use{source->local.outputStream().use{source.copyTo(it)}}
            NodeService.stop(context);Thread.sleep(1_000)
            val exe=File(context.applicationInfo.nativeLibraryDir,NativeServerCore.LIB_NAME)
            val p=ProcessBuilder(exe.absolutePath,"restore","--input",local.absolutePath,"--db",NativeServerCore.database(context).absolutePath).redirectErrorStream(true).apply{environment()["SANDWICH_RECOVERY_PASSPHRASE"]=pass}.start()
            val output=p.inputStream.bufferedReader().readText();check(p.waitFor()==0){output};local.delete()
            EasyTierHelper.getConfig(context)?.let{NodeService.start(context,it)};context.getString(R.string.restore_done)
        }.fold(onSuccess={done(true,it)},onFailure={Log.e(TAG,"restore failed",it);EasyTierHelper.getConfig(context)?.let{cfg->NodeService.start(context,cfg)};done(false,it.message?:context.getString(R.string.restore_failed))})}.start()
    }
}
