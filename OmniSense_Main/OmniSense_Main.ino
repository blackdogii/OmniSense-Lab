#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>

#include "Config.h"
#include "BitPacker.h"
#include "CommandHandler.h"
#include "SensorEngine.h"

/**
 * OmniSense Lab - 主程式入口 (Main Firmware Entry)
 * 管理 BLE 狀態、數據流與系統指令。
 */

// 初始化全域系統配置
SystemConfig g_sysConfig = {0x01, 100, BIT_12, true}; // 預設：通道 0, 100Hz, 12位元解析度

BLECharacteristic *pTxChar;
bool isConnected = false;

// BLE 伺服器狀態回調 (Server Callbacks)
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) { 
        isConnected = true; 
        Serial.println("裝置已連線 (Device connected).");
    }
    void onDisconnect(BLEServer* pServer) {
        isConnected = false;
        Serial.println("裝置連線中斷，重新開啟廣播 (Device disconnected. Advertising...)");
        pServer->getAdvertising()->start();
    }
};

// BLE 接收指令回調 (Write Callbacks)
class MyMsgCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pChar) {
        // 修正編譯錯誤：直接獲取原始數據指標與長度，避免 String 類型轉換問題
        uint8_t* pData = pChar->getData();
        size_t len = pChar->getLength();
        
        if (pData != nullptr && len > 0) {
            // 將指令交給 CommandHandler 處理
            CommandHandler::processCommand(pData, len);
        }
    }
};

void setup() {
    Serial.begin(115200);
    
    // 初始化取樣引擎
    SensorEngine::init();

    // 初始化 BLE 裝置
    BLEDevice::init("OmniSense-Base");
    BLEServer *pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());

    // 建立 BLE 服務
    BLEService *pService = pServer->createService(SERVICE_UUID);
    
    // TX 特性：用於數據串流推送 (Notify)
    pTxChar = pService->createCharacteristic(
                CHARACTERISTIC_UUID_TX,
                BLECharacteristic::PROPERTY_NOTIFY
              );
    // 必須添加 2902 描述符才能讓 Client 端接收 Notify
    pTxChar->addDescriptor(new BLE2902());

    // RX 特性：用於接收 Web 端指令 (Write)
    BLECharacteristic *pRxChar = pService->createCharacteristic(
                                 CHARACTERISTIC_UUID_RX,
                                 BLECharacteristic::PROPERTY_WRITE
                               );
    pRxChar->setCallbacks(new MyMsgCallbacks());

    // 啟動服務與廣播
    pService->start();
    pServer->getAdvertising()->start();
    Serial.println("OmniSense Lab (ESP32-C3) 已就緒。");
}

void loop() {
    // 僅在裝置已連線且系統運行中時處理數據
    if (isConnected && g_sysConfig.isRunning) {
        uint16_t samples[MAX_CHANNELS];
        uint8_t count = 0;
        uint32_t timestamp = 0;

        // 檢查 SensorEngine 是否到達取樣時間點
        if (SensorEngine::update(samples, count, timestamp)) {
            uint8_t packet[MAX_MTU];
            
            // 使用 BitPacker 進行數據打包 (8/12/16 bit 動態壓縮)
            size_t packetLength = BitPacker::pack(packet, timestamp, samples, count);
            
            // 推送數據包至 Web 主控台
            pTxChar->setValue(packet, packetLength);
            pTxChar->notify();
        }
    }
}