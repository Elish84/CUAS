#pragma once
#include <DroneReaderListener.h>
#include <as_common/msg/dds_connext/PlatformTelemetry_.hpp>
#include "../ReaderRadarDevice.h"
#include <Utils/CommonDefs.h>

using namespace as_common::msg::dds_;

template <class T>
class ReaderPlatformTelemetryControl: public ReaderRadarDevice<PlatformTelemetry_>
{
	
public:
    ReaderPlatformTelemetryControl();
    virtual ~ReaderPlatformTelemetryControl(){}

    void PublishMessage(const PlatformTelemetry_ &msg) override;
};


template <class T>
ReaderPlatformTelemetryControl<T>::ReaderPlatformTelemetryControl()
 : ReaderRadarDevice<T>()
{

}

template <class T>
void ReaderPlatformTelemetryControl<T>::PublishMessage(const PlatformTelemetry_& msg)
{
    PlatformTelemetryTopic telemetryTopic;

    if(m_pManager == nullptr)
        return;

    DDSConverterTypes::ConvertTelemetry(telemetryTopic, msg);
    emit m_pManager->signalPlatformTelemetryReceived(telemetryTopic);
    m_pManager->SetTelemetry(telemetryTopic);
}
