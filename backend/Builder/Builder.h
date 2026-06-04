#pragma once

#include <QThread>
#include <map>
#include <Utils/ObjectBase.h>
#include <Utils/ObjectStore.h>


class Builder : public QObject
{
    Q_OBJECT

public:

    explicit Builder(QString baseDirectory);

    virtual ~Builder()
    {
        for (auto const & iter : m_mapThreads)
        {
            // Notify the thread manager to stop the thread. The worker class destructor will be called
            iter.second->quit();
            // Wait for thread cleanup
            if(!iter.second->wait(1000))
            {
                // Hopefully we won't reach this
                iter.second->terminate();
            }
        }
        ObjectStore::GetReference().Clear();
    }

    void BuildConstructors();

    void BuildFiles(QString szConfigurationFile);

    void Initialize()
    {
        for (auto const & iter : m_mapManagers) {
            iter.second->Initialize();
        }
    }

    void Run()
    {
        for (auto const & iter : m_mapThreads)
        {
            // Actually start the thread manager (which will call the DoWork in the worker class)
            iter.second->start();
        }
    }


private:

    void InsertManager( ObjectBase* pManager)
    {
        // worker class (Manager)
        m_mapManagers.insert( std::pair<QString, ObjectBase*>(pManager->objectName(), pManager));

        // Create a Thread manager
        QThread* pThread = new QThread();
        // Move the worker class to the thread manager
        pManager->moveToThread(pThread);
        // Connect the thread manager events to the worker class and object
        connect(pThread, &QThread::started,     pManager, &ObjectBase::Run);
        connect(pThread, &QThread::finished,    pManager, &QObject::deleteLater);
        m_mapThreads.insert( std::pair<QString, QThread*>(pManager->objectName(), pThread));
    }

    void SetLogLevel();

    std::map <QString, ObjectBase*> m_mapManagers;
    std::map <QString, QThread*>    m_mapThreads;
    QString                         m_log_level;
    QString                         m_baseDir;
};

