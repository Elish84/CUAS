#pragma once

#include <QObject>
#include <Utils/ObjectStore.h>
#include <Common/ProjectDefs.h>
#include <Files/ConfigStore.h>
#include <Files/ParamStore.h>
#include <QList>
#include <QTimer>
#include <QJsonObject>
#include "RadarDevice.h"
#include "../WebSocketMgr/WebsocketMgr.h"

#pragma pack(1)

class RadarMgr : public ObjectBase
{
    Q_OBJECT

public:
    explicit RadarMgr(const QString& szObjectName);
    virtual ~RadarMgr() override;
    virtual void Initialize() override;
    virtual void Run() override;

    QList<RadarDevice *> m_radarDeviceList;
    QList<RadarConfigs> m_radarConfigList;

    void SetTelemetry(PlatformTelemetryTopic telem);

signals:
    void signalPlatformTelemetryReceived(PlatformTelemetryTopic telemetryTopic);
    void signalEOPayloadControlMode(OperationMode mode);

public slots:
    // Slot to receive commands from WebSocket
    void handleWebSocketCommand(const QJsonObject& command);

private slots:
    void slotHandleEoPayloadControlModeTopic(OperationMode mode);

private:

    /************************************ Attributes ***************************************/

    ParamStore         *m_pParamStore      = nullptr;
    RadarDevice*       pRadarDevice_1      = nullptr;
    RadarDevice*       pRadarDevice_2      = nullptr;
    RadarCommon        m_radarCommonParams;

    PlatformTelemetryTopic  m_platformTelemetryTopicMsg;
    OperationMode           m_currentMode = OperationMode::OPERATION_MODE_IDLE;
    uint8_t                 m_requestedDetectionMode = 0;

    // WebSocket Manager
    WebsocketMgr*           m_pWebsocketMgr = nullptr;
};

#pragma pack()
