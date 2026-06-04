#pragma once


#include <iostream>
#include <math.h>
#include <eigen3/Eigen/Geometry>
#include <eigen3/Eigen/Core>
#include <eigen3/Eigen/Dense>
#include <typeinfo>
#include "UTM.h"

//wrapTransform convertRadarAzElR2Geo(float uav_latitude, float uav_longtitude, float uav_altitude,
//                              float q_ref2fin_w, float q_ref2fin_x, float q_ref2fin_y, float q_ref2fin_z,
//                              float target_az, float target_el, float target_range);

wrapTransform convertRadarAzElR2GeoTelemFromUav(float uav_latitude, float uav_longtitude, float uav_altitude,
                                          float target_az, float target_el, float target_range,
                                          float telem_roll, float telem_pitch, float telem_yaw ,
                                          float setup_roll, float setup_pitch, float setup_yaw );

#pragma pack()
