#pragma once

#include <Utils/ObjectBase.h>
#include "Common/ProjectDefs.h"

class QSettings;

class ParamStore : public ObjectBase
{
    Q_OBJECT

public:

    struct DbParamsStruct
    {
        QString strDbFilePath;
        QString strInstallFilePath;
    };

    ParamStore(const QString& szObjectName, const QString& szPath);

    ~ParamStore();

    /* Getters */

    const QString& payloadId();
    const QString& platformId();

    const TopicRefNames& topic_names();
    const RadarCommon& radar_common();
    const ApplicationParams& app_common();
//    const RadarConfigs& radarConfigs();
    const std::tuple<RadarConfigs,RadarConfigs> radarConfigs();

    const std::vector<int>& getCapabilitiesList();
    const std::vector<int>& getOperatorsList();

    const bool& getCheckHeightFilterForDrones() { return m_checkHeightFilterForDrones;}

private:



    QSettings*  m_settings = nullptr;

    TopicRefNames           m_topic_names;
    RadarConfigs            m_radarConfigs_1;
    RadarConfigs            m_radarConfigs_2;
    RadarCommon             m_radarCommonParams;
    ApplicationParams       m_appParams;
    std::vector<int>        m_capabilitiesList;
    std::vector<int>        m_operatorsList;
    bool                    m_checkHeightFilterForDrones;
};


