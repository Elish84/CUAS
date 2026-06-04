#pragma once
#include <DroneReaderListener.h>
#include "RadarMgr.h"

class RadarMgr;

template <class T>
class ReaderRadarDevice : public DroneReaderListener<T>
{
	
public:
    ReaderRadarDevice();
    virtual ~ReaderRadarDevice(){}

    virtual void PublishMessage(const T& msg) = 0;

    void SetManager(RadarMgr* pMgr)
    {
        m_pManager = pMgr;
    }

protected:

    RadarMgr* m_pManager = nullptr;
};


template <class T>
ReaderRadarDevice<T>::ReaderRadarDevice()
 : DroneReaderListener<T>()
{

}

