#include "DDSBuilder.h"
#include <dds/pub/ddspub.hpp>
#include <dds/core/QosProvider.hpp>

#include <as_eo_payload/msg/dds_connext/EOPayloadStatus_.hpp>
#include <as_eo_payload/msg/dds_connext/EOPayloadControlMode_.hpp>
#include <as_detection/msg/dds_connext/Detection_.hpp>
#include <as_common/msg/dds_connext/PlatformTelemetry_.hpp>
#include <as_video/msg/dds_connext/VideoStatus_.hpp>
#include <as_platform/msg/dds_connext/PayloadInfo_.hpp>

using namespace as_detection::msg::dds_;
using namespace as_eo_payload::msg::dds_;
using namespace as_video::msg::dds_;
//using namespace as_dvr::msg::dds_;
//using namespace as_health::msg::dds_;

DDSBuilder::DDSBuilder(const QString& szObjectName):
    ObjectBase(szObjectName)
{
    auto pParamStore = ObjectStore::GetReference().GetObjectByName<ParamStore>(str_ParamStore);
    m_topicNames = pParamStore->topic_names();

#ifndef linux
    QString qosPath = pParamStore->app_common().qosWinPath;
#else
    QString qosPath = pParamStore->app_common().qosLinuxPath;
#endif

    try{
        rti::core::QosProviderParams provider_params;
        provider_params.url_profile(dds::core::StringSeq(1, qosPath.toStdString()));
        dds::core::QosProvider::Default()->default_provider_params(provider_params);
        rti::domain::DomainParticipantConfigParams params(0);

        // ---------------------------------------------------- TOPICS -------------------------------------------------- //
        rti::domain::register_type<as_detection::msg::dds_::Detection_>(m_topicNames.detectionTopicName);
        rti::domain::register_type<as_eo_payload::msg::dds_::EOPayloadStatus_>(m_topicNames.eoPayloadStatusTopicName);
        rti::domain::register_type<as_common::msg::dds_::PlatformTelemetry_>(m_topicNames.platformTelemetryTopicName);
        rti::domain::register_type<as_eo_payload::msg::dds_::EOPayloadControlMode_>(m_topicNames.eoPayoadModeTopicName);
        rti::domain::register_type<as_video::msg::dds_::VideoStatus_>(m_topicNames.videoStatusTopicName);
        rti::domain::register_type<as_platform::msg::dds_::PayloadInfo_>(m_topicNames.PayloadInfoTopicName);


        m_Participant = std::make_shared<dds::domain::DomainParticipant>
                (dds::core::QosProvider::Default()->create_participant_from_config(
                                    "ElbitParticipantLibrary::RadarParticipant", params));

    } catch (std::exception e) {
        LOG_WARNING() << e.what();
    }
}

DDSBuilder::~DDSBuilder(){}

void DDSBuilder::Initialize(){}

void DDSBuilder::Run(){}


