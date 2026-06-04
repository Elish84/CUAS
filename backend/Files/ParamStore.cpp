#include "ParamStore.h"
#include <QSettings>
#include <QDebug>
#include <QObject>
#include <QJsonDocument>
#include <qjsonobject.h>
#include <Utils/Logger.h>

ParamStore::ParamStore(const QString& szObjectName, const QString& szPath):
    ObjectBase(szObjectName)
{
    QFile configFile("/opt/ras/app/share/config/PlatformConfig.json");
    configFile.open(QIODevice::ReadOnly);
    QByteArray rawData = configFile.readAll();
    configFile.close();
    QJsonDocument doc = QJsonDocument::fromJson(rawData);
    QJsonObject obj = doc.object();
    QJsonValue val = obj.value("platformId");
    m_appParams.platformId = val.toString();
    if(m_appParams.platformId == "")
        m_appParams.platformId = "110";
    qDebug() << "platformId: " << m_appParams.platformId;
    m_settings = new QSettings(szPath, QSettings::IniFormat);


    m_settings->beginGroup("ApplicationParams");
    m_appParams.logLevel              = m_settings->value("LOG_LEVEL").toString();
    m_appParams.qosLinuxPath          = m_settings->value("QOS_LINUX_PATH").toString();
    m_appParams.recordingLinuxPath    = m_settings->value("RECORDING_LINUX_PATH").toString();
    m_appParams.qosWinPath            = m_settings->value("QOS_WIN_PATH").toString();
    m_appParams.recordingWinPath      = m_settings->value("RECORDING_WIN_PATH").toString();
    m_appParams.payloadId             = m_settings->value("PAYLOAD_ID").toString();

    m_checkHeightFilterForDrones        = m_settings->value("CHECK_HEIGHT_FILTER_FOR_DRONES").toBool();
    m_settings->endGroup();


    m_settings->beginGroup("RadarCommonParams");
    m_radarCommonParams.detectionSample       = m_settings->value("DETECTION_SAMPLE").toUInt();
    m_radarCommonParams.eoPayloadStatusSample = m_settings->value("EO_PAYLOAD_STATUS_SAMPLE").toUInt();
    m_radarCommonParams.videoStatusSample     = m_settings->value("VIDEO_STATUS_SAMPLE").toUInt();
    m_radarCommonParams.installAngle          = m_settings->value("INSTALATION_ANGLE").toFloat();
    m_radarCommonParams.fovV                  = m_settings->value("FOV_V").toFloat();
    m_radarCommonParams.fovH                  = m_settings->value("FOV_H").toFloat();
    m_radarCommonParams.minRcs                = m_settings->value("MIN_RCS").toFloat();
    m_radarCommonParams.maxRcs                = m_settings->value("MAX_RCS").toFloat();
    m_radarCommonParams.rspClutterWidth       = m_settings->value("RSP_CLUTTERWIDTH").toUInt();
    m_settings->endGroup();

    m_settings->beginGroup("TopicTypeRef");
    m_topic_names.platformTelemetryTopicName.assign(m_settings->value("PLATFORM_TELEMETRY").toString().toStdString());
    m_topic_names.detectionTopicName.assign(m_settings->value("DETECTION").toString().toStdString());
    m_topic_names.eoPayloadStatusTopicName.assign(m_settings->value("EO_PAYLOAD_STATUS").toString().toStdString());
    m_topic_names.eoPayoadModeTopicName.assign(m_settings->value("EO_PAYLOAD_CONTROL_MODE").toString().toStdString());
    m_topic_names.videoStatusTopicName.assign(m_settings->value("VIDEO_STATUS").toString().toStdString());
    m_topic_names.PayloadInfoTopicName.assign(m_settings->value("PAYLOAD_INFO").toString().toStdString());
    m_settings->endGroup();

    m_settings->beginGroup("CAPABILITIES");

    QStringList capabilities = m_settings->value("CapabilitiesList").toStringList();
    for(int i = 0; i < capabilities.size(); i++)
    {
        QString str = capabilities.at(i);
        m_capabilitiesList.push_back(str.toInt());
    }
    m_settings->endGroup();


    m_settings->beginGroup("Params_1");
    m_radarConfigs_1.radarName          = m_settings->value("RADAR_NAME").toString();
    m_radarConfigs_1.radarId            = m_settings->value("RADAR_ID").toString();
    m_radarConfigs_1.serverId           = m_settings->value("SERVER_ID").toString();
    m_radarConfigs_1.serverPort         = m_settings->value("SERVER_PORT").toUInt();
    m_radarConfigs_1.isActive           = m_settings->value("IS_ACTIVE").toBool();
    m_radarConfigs_1.installRoll        = m_settings->value("INSTALL_ROLL").toFloat();
    m_radarConfigs_1.installPitch       = m_settings->value("INSTALL_PITCH").toFloat();
    m_radarConfigs_1.installYaw         = m_settings->value("INSTALL_YAW").toFloat();
    m_radarConfigs_1.frequencyChannel   = m_settings->value("FREQUENCY_CHANNEL").toUInt();

    m_settings->endGroup();


    m_settings->beginGroup("RadarConfigs_1");
    m_radarConfigs_1.probUav               = m_settings->value("PROBABILITY_UAV").toFloat();
    m_radarConfigs_1.aerialClassAgl        = m_settings->value("AERIAL_CLASSIFICATION_AGL").toUInt();
    m_radarConfigs_1.detectionMode         = m_settings->value("DETECTION_MODE").toUInt();
    m_settings->endGroup();


    m_settings->beginGroup("FILTERS_PARAMS_1");
    m_radarConfigs_1.filterConfigs.groundRangeMax     = m_settings->value("GROUND_RANGE_MAX").toUInt();
    m_radarConfigs_1.filterConfigs.groundSpeedMax     = m_settings->value("GROUND_MAX_SPEED").toFloat();
    m_radarConfigs_1.filterConfigs.groundSpeedMin     = m_settings->value("GROUND_MIN_SPEED").toFloat();
    m_radarConfigs_1.filterConfigs.groundFilterGround = m_settings->value("GROUND_FILTER_GROUND").toBool();

    m_radarConfigs_1.filterConfigs.aerialRangeMax     = m_settings->value("AERIAL_RANGE_MAX").toUInt();
    m_radarConfigs_1.filterConfigs.aerialSpeedMax     = m_settings->value("AERIAL_MAX_SPEED").toFloat();
    m_radarConfigs_1.filterConfigs.aerialSpeedMin     = m_settings->value("AERIAL_MIN_SPEED").toFloat();
    m_radarConfigs_1.filterConfigs.aerialFilterUas    = m_settings->value("AERIAL_FILTER_UAS").toBool();

    m_radarConfigs_1.filterConfigs.allRangeMax        = m_settings->value("ALL_RANGE_MAX").toUInt();
    m_radarConfigs_1.filterConfigs.allSpeedMax        = m_settings->value("ALL_MAX_SPEED").toFloat();
    m_radarConfigs_1.filterConfigs.allSpeedMin        = m_settings->value("ALL_MIN_SPEED").toFloat();
    m_radarConfigs_1.filterConfigs.allFilterUas       = m_settings->value("ALL_FILTER_UAS").toBool();
    m_settings->endGroup();


    m_settings->beginGroup("FOV_PARAMS_1");
    m_radarConfigs_1.groundFovConfigs.azimuthFovMax   = m_settings->value("GROUND_AZIMUTH_FOV_MAX").toFloat();
    m_radarConfigs_1.groundFovConfigs.azimuthFovMin   = m_settings->value("GROUND_AZIMUTH_FOV_MIN").toFloat();
    m_radarConfigs_1.groundFovConfigs.elevationFovMax = m_settings->value("GROUND_ELEVATION_FOV_MAX").toFloat();
    m_radarConfigs_1.groundFovConfigs.elevationFovMin = m_settings->value("GROUND_ELEVATION_FOV_MIN").toFloat();

    m_radarConfigs_1.aerialFovConfigs.azimuthFovMax   = m_settings->value("AERIAL_AZIMUTH_FOV_MAX").toFloat();
    m_radarConfigs_1.aerialFovConfigs.azimuthFovMin   = m_settings->value("AERIAL_AZIMUTH_FOV_MIN").toFloat();
    m_radarConfigs_1.aerialFovConfigs.elevationFovMax = m_settings->value("AERIAL_ELEVATION_FOV_MAX").toFloat();
    m_radarConfigs_1.aerialFovConfigs.elevationFovMin = m_settings->value("AERIAL_ELEVATION_FOV_MIN").toFloat();
    m_radarConfigs_1.aerialFovConfigs.aglHeightMin    = m_settings->value("AERIAL_MIN_HEIGHT_AGL").toFloat();
    m_radarConfigs_1.aerialFovConfigs.aglHeightMax    = m_settings->value("AERIAL_MAX_HEIGHT_AGL").toFloat();

    m_radarConfigs_1.allFovConfigs.azimuthFovMax   = m_settings->value("ALL_AZIMUTH_FOV_MAX").toFloat();
    m_radarConfigs_1.allFovConfigs.azimuthFovMin   = m_settings->value("ALL_AZIMUTH_FOV_MIN").toFloat();
    m_radarConfigs_1.allFovConfigs.elevationFovMax = m_settings->value("ALL_ELEVATION_FOV_MAX").toFloat();
    m_radarConfigs_1.allFovConfigs.elevationFovMin = m_settings->value("ALL_ELEVATION_FOV_MIN").toFloat();
    m_settings->endGroup();

    m_settings->beginGroup("Params_2");
    m_radarConfigs_2.radarName          = m_settings->value("RADAR_NAME").toString();
    m_radarConfigs_2.radarId            = m_settings->value("RADAR_ID").toString();
    m_radarConfigs_2.serverId           = m_settings->value("SERVER_ID").toString();
    m_radarConfigs_2.serverPort         = m_settings->value("SERVER_PORT").toUInt();
    m_radarConfigs_2.isActive           = m_settings->value("IS_ACTIVE").toBool();
    m_radarConfigs_2.installRoll        = m_settings->value("INSTALL_ROLL").toFloat();
    m_radarConfigs_2.installPitch       = m_settings->value("INSTALL_PITCH").toFloat();
    m_radarConfigs_2.installYaw         = m_settings->value("INSTALL_YAW").toFloat();
    m_radarConfigs_2.frequencyChannel   = m_settings->value("FREQUENCY_CHANNEL").toUInt();
    m_settings->endGroup();


    m_settings->beginGroup("RadarConfigs_2");
    m_radarConfigs_2.probUav               = m_settings->value("PROBABILITY_UAV").toFloat();
    m_radarConfigs_2.aerialClassAgl        = m_settings->value("AERIAL_CLASSIFICATION_AGL").toUInt();
    m_radarConfigs_2.detectionMode         = m_settings->value("DETECTION_MODE").toUInt();
    m_settings->endGroup();


    m_settings->beginGroup("FILTERS_PARAMS_2");
    m_radarConfigs_2.filterConfigs.groundRangeMax     = m_settings->value("GROUND_RANGE_MAX").toUInt();
    m_radarConfigs_2.filterConfigs.groundSpeedMax     = m_settings->value("GROUND_MAX_SPEED").toFloat();
    m_radarConfigs_2.filterConfigs.groundSpeedMin     = m_settings->value("GROUND_MIN_SPEED").toFloat();
    m_radarConfigs_2.filterConfigs.groundFilterGround = m_settings->value("GROUND_FILTER_GROUND").toBool();

    m_radarConfigs_2.filterConfigs.aerialRangeMax     = m_settings->value("AERIAL_RANGE_MAX").toUInt();
    m_radarConfigs_2.filterConfigs.aerialSpeedMax     = m_settings->value("AERIAL_MAX_SPEED").toFloat();
    m_radarConfigs_2.filterConfigs.aerialSpeedMin     = m_settings->value("AERIAL_MIN_SPEED").toFloat();
    m_radarConfigs_2.filterConfigs.aerialFilterUas    = m_settings->value("AERIAL_FILTER_UAS").toBool();

    m_radarConfigs_2.filterConfigs.allRangeMax        = m_settings->value("ALL_RANGE_MAX").toUInt();
    m_radarConfigs_2.filterConfigs.allSpeedMax        = m_settings->value("ALL_MAX_SPEED").toFloat();
    m_radarConfigs_2.filterConfigs.allSpeedMin        = m_settings->value("ALL_MIN_SPEED").toFloat();
    m_radarConfigs_2.filterConfigs.allFilterUas       = m_settings->value("ALL_FILTER_UAS").toBool();
    m_settings->endGroup();


    m_settings->beginGroup("FOV_PARAMS_2");
    m_radarConfigs_2.groundFovConfigs.azimuthFovMax   = m_settings->value("GROUND_AZIMUTH_FOV_MAX").toFloat();
    m_radarConfigs_2.groundFovConfigs.azimuthFovMin   = m_settings->value("GROUND_AZIMUTH_FOV_MIN").toFloat();
    m_radarConfigs_2.groundFovConfigs.elevationFovMax = m_settings->value("GROUND_ELEVATION_FOV_MAX").toFloat();
    m_radarConfigs_2.groundFovConfigs.elevationFovMin = m_settings->value("GROUND_ELEVATION_FOV_MIN").toFloat();

    m_radarConfigs_2.aerialFovConfigs.azimuthFovMax   = m_settings->value("AERIAL_AZIMUTH_FOV_MAX").toFloat();
    m_radarConfigs_2.aerialFovConfigs.azimuthFovMin   = m_settings->value("AERIAL_AZIMUTH_FOV_MIN").toFloat();
    m_radarConfigs_2.aerialFovConfigs.elevationFovMax = m_settings->value("AERIAL_ELEVATION_FOV_MAX").toFloat();
    m_radarConfigs_2.aerialFovConfigs.elevationFovMin = m_settings->value("AERIAL_ELEVATION_FOV_MIN").toFloat();
    m_radarConfigs_2.aerialFovConfigs.aglHeightMin    = m_settings->value("AERIAL_MIN_HEIGHT_AGL").toFloat();
    m_radarConfigs_2.aerialFovConfigs.aglHeightMax    = m_settings->value("AERIAL_MAX_HEIGHT_AGL").toFloat();

    m_radarConfigs_2.allFovConfigs.azimuthFovMax   = m_settings->value("ALL_AZIMUTH_FOV_MAX").toFloat();
    m_radarConfigs_2.allFovConfigs.azimuthFovMin   = m_settings->value("ALL_AZIMUTH_FOV_MIN").toFloat();
    m_radarConfigs_2.allFovConfigs.elevationFovMax = m_settings->value("ALL_ELEVATION_FOV_MAX").toFloat();
    m_radarConfigs_2.allFovConfigs.elevationFovMin = m_settings->value("ALL_ELEVATION_FOV_MIN").toFloat();
    m_settings->endGroup();
}

ParamStore::~ParamStore()
{
    delete m_settings;
}

const QString& ParamStore::payloadId()
{
    return m_appParams.payloadId;
}

const QString& ParamStore::platformId()
{
    return m_appParams.platformId;
}

const TopicRefNames& ParamStore::topic_names()
{
    return m_topic_names;
}

const RadarCommon& ParamStore::radar_common()
{
    return m_radarCommonParams;
}

const ApplicationParams& ParamStore::app_common()
{
    return m_appParams;
}

const std::vector<int>& ParamStore::getCapabilitiesList()
{
    return m_capabilitiesList;
}

const std::vector<int>& ParamStore::getOperatorsList()
{
    return m_operatorsList;
}

const std::tuple<RadarConfigs, RadarConfigs> ParamStore::radarConfigs()
{
    return std::make_tuple(m_radarConfigs_1, m_radarConfigs_2);
}
