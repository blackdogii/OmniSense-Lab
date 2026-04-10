/*
 * OmniSense Lab — 主程式（ESP32-C3 BLE）
 * 目前釋出：0.3.3 · 版本規則：docs/VERSIONING.md
 * 作者：小威老師 · 授權：見倉庫 LICENSE
 */
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <BLEAdvertising.h>

#include "Config.h"
#include "BitPacker.h"
#include "CommandHandler.h"
#include "SensorEngine.h"

/* 預設：通道 0 啟用；上拉預設 GPIO20/21；touchModeMask=0；firmwareVersionField 見 OMNISENSE_VERSION_CODE */
SystemConfig g_sysConfig = {0x0001, 0x0180, 100, BIT_12, true, 0, OMNISENSE_VERSION_CODE};
BLECharacteristic *pTxChar;
bool isConnected = false;

/**
 * 核心修正：iOS 友善廣播配置
 * 1. 主廣播包 (adv)：只放 Flags + 16-bit UUID (僅佔 4 bytes)，確保 iPhone 必能搜到。
 * 2. 掃描回應包 (scan)：放裝置名稱，避免主包超過 31 bytes 的硬體限制。
 */
static void configureAdvertising(BLEServer* pServer) {
    BLEAdvertising *pAdvertising = pServer->getAdvertising();
    pAdvertising->stop();

    // --- 主廣播資料 (Advertising Data) ---
    BLEAdvertisementData adv;
    adv.setFlags(0x06); 
    adv.setCompleteServices(BLEUUID(SERVICE_UUID)); // 使用 16-bit UUID

    // --- 掃描回應資料 (Scan Response) ---
    BLEAdvertisementData scan;
    scan.setName(BLE_DEVICE_NAME); 

    pAdvertising->setAdvertisementData(adv);
    pAdvertising->setScanResponseData(scan);
    pAdvertising->setScanResponse(true);

    // 縮短間隔有利於手機快速發現裝置
    pAdvertising->setMinInterval(0x0030); 
    pAdvertising->setMaxInterval(0x0060); 

    pAdvertising->start();
    Serial.printf("OmniSense 已啟動廣播：[%s]\n", BLE_DEVICE_NAME);
}

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) { isConnected = true; Serial.println("連線成功"); }
    void onDisconnect(BLEServer* pServer) {
        isConnected = false;
        Serial.println("連線中斷，重新廣播...");
        pServer->getAdvertising()->start(); 
    }
};

class MyMsgCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pChar) {
        uint8_t* pData = pChar->getData();
        size_t len = pChar->getLength();
        if (pData != nullptr && len > 0) {
            CommandHandler::processCommand(pData, len);
        }
    }
};

void setup() {
    Serial.begin(115200);
    Serial.printf("OmniSense Lab %s (0x%04X, FW=%u WEB=%u)\n", OMNISENSE_FW_VERSION,
                  (unsigned)OMNISENSE_VERSION_CODE, (unsigned)OMNISENSE_VER_FW, (unsigned)OMNISENSE_VER_WEB);
    SensorEngine::init();

    BLEDevice::init(BLE_DEVICE_NAME);
    BLEServer *pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());

    // 建立服務 (使用 16-bit UUID)
    BLEService *pService = pServer->createService(BLEUUID(SERVICE_UUID));
    
    // TX: Notify 數據推送
    pTxChar = pService->createCharacteristic(
                BLEUUID(CHARACTERISTIC_UUID_TX),
                BLECharacteristic::PROPERTY_NOTIFY
              );
    pTxChar->addDescriptor(new BLE2902());

    // RX: Write 指令接收
    BLECharacteristic *pRxChar = pService->createCharacteristic(
                                 BLEUUID(CHARACTERISTIC_UUID_RX),
                                 BLECharacteristic::PROPERTY_WRITE
                               );
    pRxChar->setCallbacks(new MyMsgCallbacks());

    pService->start();
    configureAdvertising(pServer);
}

void loop() {
    uint16_t samples[MAX_CHANNELS];
    uint8_t count = 0;
    uint32_t timestampUs = 0;

    if (SensorEngine::takePending(samples, count, timestampUs)) {
        if (isConnected && g_sysConfig.isRunning) {
            uint8_t packet[MAX_MTU];
            size_t packetLength = BitPacker::pack(packet, timestampUs, samples, count);
            pTxChar->setValue(packet, packetLength);
            pTxChar->notify();
        }
    }
    delay(1);
}