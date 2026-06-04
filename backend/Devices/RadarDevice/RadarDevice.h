#pragma once

#include <Utils/ObjectBase.h>
#include <QObject>
#include <Utils/CommonDefs.h>
#include <Common/ProjectDefs.h>
#include <Files/ParamStore.h>
#include <Utils/ObjectStore.h>
#include <Utils/Logger.h>
#include "RadarDefs.h"
#include <QTimer>
#include <QList>

#include <QJsonObject>
#include <QJsonDocument>

#include <bnet_interface.h>
#include "../../UTM/coordinate_transformation.h"

#pragma pack(1)

class RadarDevice : public ObjectBase
{
    Q_OBJECT

public:

signals:
    void signalDetectionReceived(QJsonObject detection);

    explicit RadarDevice(const QString& szObjectName, RadarConfigs radarConfig);
    virtual ~RadarDevice() override;
    virtual void Initialize() override;
    virtual void Run() override;

public slots:
    void slotHandlePlatformTelemetryTopic(PlatformTelemetryTopic telemetryTopic);
    void slotHandleEoPayloadControlModeTopic(OperationMode mode);

private:
    /********************************** Functionality **************************************/

    /* Handlers */
    bool doConnect();
    void checkTrack();

    /* Topic writers */
    void writeDetectionTopic(track_data track, sstat_data* radarStatusData);

    /* Miscellaneous */
    void printTrack(track_data track);
    bool applyConfigFilters(track_data track, uint8_t classification);
    void printGroundFilters(track_data &track, float trackAvgSpeed);
    void printAerialFilters(track_data &track, float trackAvgSpeed);
    void printAllFilters(track_data &track, float trackAvgSpeed);
	float deg2rad(float degree);
    FovConfigs getRadarConfigs();
    std::pair<mesa_command_status_t, std::string> sendCommand(std::string cmd, std::string cmdParam);
    void setClassifiction(track_data track);

    /************************************ Attributes ***************************************/

    bnet_interface          m_bnet;
    ParamStore              *m_pParamStore      = nullptr;
    RadarCommon             m_radarCommonParams;
    ApplicationParams       m_appParams;
    QList<QString>          m_detectionsList;
    float                   m_currentSurfaceHeight = 0;
    bool                    m_checkHeightFilterForDrones = false;

    /* Timers */
    QTimer                  *m_detectionSampleTimer    = nullptr;

    /* Topics */
    QJsonObject             m_detectionMsg;
    PlatformTelemetryTopic  m_platformTelemetryTopicMsg;

    /* Ini file parameters */
    QString                 m_szSessionFolder;
    TopicRefNames           m_topicNames;

    // ---------------------- DDS Removed -------------------------------

public:
    RadarConfigs            m_radarConfigs;
};

#pragma pack()
