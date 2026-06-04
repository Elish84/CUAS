#pragma once

#include <Utils/ObjectBase.h>
#include <QObject>
#include <Utils/CommonDefs.h>
#include <Utils/ObjectStore.h>
#include <Utils/Logger.h>
#include <Files/ParamStore.h>
#include <Common/ProjectDefs.h>
#include <dds/pub/ddspub.hpp>

#pragma pack(1)

class DDSBuilder : public ObjectBase
{
    Q_OBJECT

public:

    explicit DDSBuilder(const QString& szObjectName);
    virtual ~DDSBuilder() override;
    virtual void Initialize() override;
    virtual void Run() override;

private:

    TopicRefNames m_topicNames;

   // ---------------------- Domain Participant -------------------------------

   std::shared_ptr<dds::domain::DomainParticipant>      m_Participant;
};



#pragma pack()
