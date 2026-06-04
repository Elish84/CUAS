#include "RadarMgr.h"
#include <Utils/Logger.h>
#include <QJsonArray>

RadarMgr::RadarMgr(const QString& szObjectName):
    ObjectBase(szObjectName)
{
    try{
        m_pWebsocketMgr = new WebsocketMgr(8080, this);
        connect(m_pWebsocketMgr, &WebsocketMgr::commandReceived, this, &RadarMgr::handleWebSocketCommand);
    } catch (std::exception e) {
        LOG_WARNING() << e.what();
    }
}

RadarMgr::~RadarMgr()
{
}

void RadarMgr::Initialize()
{
}

void RadarMgr::Run()
{
    m_pParamStore = ObjectStore::GetReference().GetObjectByName<ParamStore>(str_ParamStore);
    m_radarCommonParams = m_pParamStore->radar_common();

    for (int i=0; i < m_radarDeviceList.length(); i++)
    {
        auto pRadarDevice  = ObjectStore::GetReference().GetObjectByName<RadarDevice>(m_radarDeviceList.at(i)->m_radarConfigs.radarName);
        if(pRadarDevice->m_radarConfigs.isActive)
        {
            m_radarConfigList.append(m_radarDeviceList.at(i)->m_radarConfigs);
            // Connect signals from Manager to Radar devices
            connect(this, &RadarMgr::signalPlatformTelemetryReceived,    pRadarDevice, &RadarDevice::slotHandlePlatformTelemetryTopic);
            connect(this, &RadarMgr::signalEOPayloadControlMode,         pRadarDevice, &RadarDevice::slotHandleEoPayloadControlModeTopic);
            connect(this, &RadarMgr::signalEOPayloadControlMode,         this, &RadarMgr::slotHandleEoPayloadControlModeTopic);

            // Connect detections from RadarDevice to WebSocketMgr
            connect(pRadarDevice, &RadarDevice::signalDetectionReceived, m_pWebsocketMgr, &WebsocketMgr::broadcastDetection);
        }
    }

    if (m_radarDeviceList.length() > 0)
        m_requestedDetectionMode = static_cast<uint8_t>(m_radarDeviceList.at(0)->m_radarConfigs.detectionMode);

    LOG_INFO() << "Num of active radars: " << m_radarDeviceList.length();
}

void RadarMgr::SetTelemetry(PlatformTelemetryTopic telem)
{
    m_platformTelemetryTopicMsg = telem;
}

/* ---------------------------------Slots---------------------------------------*/
void RadarMgr::slotHandleEoPayloadControlModeTopic(OperationMode mode)
{
    m_currentMode = mode;
}

void RadarMgr::handleWebSocketCommand(const QJsonObject& command)
{
    // Handle JSON commands from the frontend (e.g. Set Home, Turn On/Off)
    if (command.contains("action")) {
        QString action = command["action"].toString();
        
        if (action == "turnOn") {
            emit signalEOPayloadControlMode(OperationMode::OPERATION_MODE_SCAN);
        } else if (action == "turnOff") {
            emit signalEOPayloadControlMode(OperationMode::OPERATION_MODE_IDLE);
        } else if (action == "configure") {
            QJsonArray radarsArray = command["radars"].toArray();
            
            // Cleanup existing radars
            for (auto pRadar : m_radarDeviceList) {
                pRadar->deleteLater();
            }
            m_radarDeviceList.clear();
            m_radarConfigList.clear();

            for (int i = 0; i < radarsArray.size(); i++) {
                QJsonObject radarJson = radarsArray[i].toObject();
                if (!radarJson["isActive"].toBool()) continue;

                RadarConfigs config;
                config.radarId = QString::number(radarJson["id"].toInt());
                config.radarName = "Radar_" + config.radarId;
                config.serverId = radarJson["ip"].toString();
                config.serverPort = 50000; // default bnet port
                config.isActive = true;
                
                config.installRoll = 0.0f;
                config.installPitch = 0.0f;
                config.installYaw = radarJson["heading"].toDouble();

                // Fov Configs mapping
                config.allFovConfigs.azimuthFovMin = radarJson["azFovMin"].toDouble();
                config.allFovConfigs.azimuthFovMax = radarJson["azFovMax"].toDouble();
                config.allFovConfigs.elevationFovMin = -30.0f;
                config.allFovConfigs.elevationFovMax = 30.0f;
                config.detectionMode = OperationMode::OPERATION_MODE_ALL_DETECTIONS;
                
                config.filterConfigs.allRangeMax = radarJson["maxRange"].toDouble() * 1000.0;
                config.filterConfigs.allSpeedMax = 100.0f;
                config.filterConfigs.allSpeedMin = 0.0f;
                config.filterConfigs.allFilterUas = false;

                auto pRadarDevice = new RadarDevice(config.radarName, config);
                pRadarDevice->Initialize();
                pRadarDevice->Run();
                
                m_radarDeviceList.append(pRadarDevice);
                m_radarConfigList.append(config);

                connect(this, &RadarMgr::signalPlatformTelemetryReceived,    pRadarDevice, &RadarDevice::slotHandlePlatformTelemetryTopic);
                connect(this, &RadarMgr::signalEOPayloadControlMode,         pRadarDevice, &RadarDevice::slotHandleEoPayloadControlModeTopic);
                connect(pRadarDevice, &RadarDevice::signalDetectionReceived, m_pWebsocketMgr, &WebsocketMgr::broadcastDetection);
            }
            LOG_INFO() << "Configured " << m_radarDeviceList.size() << " active radars from UI";
        }
    }
}
