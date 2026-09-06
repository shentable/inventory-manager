package com.sandwich.inventory

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver:BroadcastReceiver(){
    override fun onReceive(context:Context,intent:Intent){
        if(intent.action==Intent.ACTION_BOOT_COMPLETED&&NodeConfig.shouldResume(context)){
            EasyTierHelper.getConfig(context)?.let{NodeService.start(context,it)}
        }
    }
}
