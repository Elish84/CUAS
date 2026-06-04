#pragma once
#include <DroneReaderListener.h>
#include <as_eo_payload/msg/dds_connext/EOPayloadControlMode_.hpp>
#include "../ReaderRadarDevice.h"
#include <Utils/CommonDefs.h>

using namespace as_eo_payload::msg::dds_;

template <class T>
class ReaderEOPayloadControlMode : public ReaderRadarDevice<EOPayloadControlMode_>
{
	
public:
    ReaderEOPayloadControlMode();
    virtual ~ReaderEOPayloadControlMode(){}

    void PublishMessage(const EOPayloadControlMode_ &msg) override;

};


template <class T>
ReaderEOPayloadControlMode<T>::ReaderEOPayloadControlMode()
 : ReaderRadarDevice<T>()
{

}

template <class T>
void ReaderEOPayloadControlMode<T>::PublishMessage(const EOPayloadControlMode_& msg)
{
    EOPayloadControlModeTopic payloadControlModeTopic;
    OperationMode mode;

    if(m_pManager == nullptr)
        return;

    LOG_DEBUG() << "In ReaderEOPayloadControlMode";

    if(DDSConverterTypes::ConvertRecipientSourceTypeDvr(payloadControlModeTopic.recipient, msg.recipient_()))
    {
        LOG_DEBUG() << "Control payload mode topic: " << static_cast<uint>(msg.mode_().val_());
        switch(msg.mode_().val_())
        {
        case OperationMode_Constants::SCAN_:
            LOG_INFO() << "On Change Mode - Turn To SCAN";
            mode = OperationMode::OPERATION_MODE_SCAN;
            emit m_pManager->signalEOPayloadControlMode(mode);

            break;

        case OperationMode_Constants::IDLE_:
            LOG_INFO() << "On Change Mode - Turn To IDLE";
            mode = OperationMode::OPERATION_MODE_IDLE;
            emit m_pManager->signalEOPayloadControlMode(mode);

            break;

        case OperationMode_Constants::GROUND_DETECTIONS_:
            LOG_INFO() << "On Change Mode - Turn To GROUND_DETECTIONS";
            mode = OperationMode::OPERATION_MODE_GROUND_DETECTIONS;
            emit m_pManager->signalEOPayloadControlMode(mode);

            break;

        case OperationMode_Constants::AERIAL_DETECTIONS_:
            LOG_INFO() << "On Change Mode - Turn To AERIAL_DETECTIONS";
            mode = OperationMode::OPERATION_MODE_AERIAL_DETECTIONS;
            emit m_pManager->signalEOPayloadControlMode(mode);

            break;
        case OperationMode_Constants::ALL_DETECTIONS_:
            LOG_INFO() << "On Change Mode - Turn To ALL_DETECTIONS";
            mode = OperationMode::OPERATION_MODE_ALL_DETECTIONS;
            emit m_pManager->signalEOPayloadControlMode(mode);

            break;

        default:
            LOG_INFO() << "On Change Mode default, value received: " << msg.mode_().val_();
            break;
        }
    }
    return;
}



