// OpenClawDiscovery.kt
// VisionClaw
// Autonomous mDNS Network Discovery helper for OpenClaw Gateway on the LAN

package com.visionclaw.wearable

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo

public class OpenClawDiscovery(
    private val context: Context,
    private val onDiscovered: (String, Int) -> Unit
) {
    private var nsdManager: NsdManager? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    private val SERVICE_TYPE_PRIMARY = "_openclaw._tcp."
    private val SERVICE_TYPE_FALLBACK = "_http._tcp."

    public fun startDiscovery() {
        System.out.println("[OpenClawDiscovery] Initializing NsdManager and beginning LAN autodiscovery scan...")
        nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
        initializeDiscoveryListener()
        nsdManager?.discoverServices(SERVICE_TYPE_PRIMARY, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
    }

    public fun stopDiscovery() {
        try {
            discoveryListener?.let { nsdManager?.stopServiceDiscovery(it) }
        } catch (e: Exception) {
            System.err.println("[OpenClawDiscovery] Failed to stop service discovery cleanly: ${e.message}")
        }
        discoveryListener = null
        nsdManager = null
    }

    private fun initializeDiscoveryListener() {
        discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                System.err.println("[OpenClawDiscovery] Discovery start failed for $serviceType: error code $errorCode")
                if (serviceType == SERVICE_TYPE_PRIMARY) {
                    System.out.println("[OpenClawDiscovery] Retrying discovery with fallback service type: $SERVICE_TYPE_FALLBACK")
                    nsdManager?.discoverServices(SERVICE_TYPE_FALLBACK, NsdManager.PROTOCOL_DNS_SD, this)
                }
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                System.err.println("[OpenClawDiscovery] Discovery stop failed: error code $errorCode")
            }

            override fun onDiscoveryStarted(regType: String) {
                System.out.println("[OpenClawDiscovery] Network discovery actively running for type $regType")
            }

            override fun onDiscoveryStopped(regType: String) {
                System.out.println("[OpenClawDiscovery] Network discovery stopped for type $regType")
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                System.out.println("[OpenClawDiscovery] Found service on LAN: name='${serviceInfo.serviceName}', type='${serviceInfo.serviceType}'")
                
                // Match "OpenClaw" or "openclaw" in name or type
                val matchesName = serviceInfo.serviceName.contains("OpenClaw", ignoreCase = true) || 
                                  serviceInfo.serviceName.contains("openclaw", ignoreCase = true)
                val matchesType = serviceInfo.serviceType.contains("openclaw", ignoreCase = true)
                
                if (matchesName || matchesType) {
                    System.out.println("[OpenClawDiscovery] Target matching OpenClaw found. Resolving service...")
                    nsdManager?.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                            System.err.println("[OpenClawDiscovery] Resolve failed: error code $errorCode")
                        }

                        override fun onServiceResolved(resolvedServiceInfo: NsdServiceInfo) {
                            val host = resolvedServiceInfo.host.hostAddress
                            val port = resolvedServiceInfo.port
                            System.out.println("[OpenClawDiscovery] Service resolved successfully to: $host:$port")
                            onDiscovered(host, port)
                        }
                    })
                }
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                System.out.println("[OpenClawDiscovery] Service lost from network: ${serviceInfo.serviceName}")
            }
        }
    }
}
