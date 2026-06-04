
#include <iostream>
#include<math.h>
#include <eigen3/Eigen/Geometry>
#include <eigen3/Eigen/Core>
#include<eigen3/Eigen/Dense>
#include <typeinfo>
#include "UTM.h"

typedef struct wrapTransform
{
    float transformation[3];
}wrapTransform;


class GeoPose{
public:
    float latitude;
    float longtitude;
    float altitude;

};

class Pose3D{
public:
    float x;
    float y;
    float z;

};

//class Quaternion{
//public:
//    float w;
//    float x;
//    float y;
//    float z;

//};

/*
--------------------------------------------
name: deg2rad
goal: convert degrees to radians.
input: 1. degrees
output: 1. radians
--------------------------------------------
*/

float deg2rad(float degree)
{
    return (degree * (M_PI / 180));
}
/*
--------------------------------------------
name: rad2deg
goal: convert degrees to radians.
input: 1. radians
output: 1. degees
--------------------------------------------
*/
float rad2deg(float rad)
{

    return(rad * (180 / M_PI));
}
/*
--------------------------------------------
name: convertRadarAzElR2RadarXyz
goal: convert from azimute,elevation,range coordinates (sphare) to XYZ coordinates relative to radar.
input: 1. float az_radar
       2. float el_radar
       3. float range_radar
output: 1. Pose3D  target_xyz_rel_2_radar
--------------------------------------------
*/
Pose3D convertRadarAzElR2XYZ(float az_radar, float el_radar, float range_radar)
{
    Pose3D target_xyz_rel_2_radar;
    target_xyz_rel_2_radar.x = range_radar*cos(el_radar)*sin(az_radar);

    //original : i think it gives xzy
    target_xyz_rel_2_radar.y = range_radar*sin(el_radar);
    target_xyz_rel_2_radar.z = range_radar*cos(el_radar)*cos(az_radar);



    return target_xyz_rel_2_radar;
}



/*
--------------------------------------------
name: convertRadarXyz2Enu
goal: convert from xyz to ENU (east-north-up) coordinates relative to radar.
input: 1. Pose3D target_xyz_rel_2_radar
       2. Quaternion q_ref2fin
output: 1. Pose3D  target_enu_rel_2_radar
--------------------------------------------
*/
Pose3D convertRadarXyz2Enu(Pose3D target_xyz_rel_2_radar,const Eigen::Quaterniond& q_ref2fin)
{
    Pose3D  target_enu_rel_2_radar;
    //-------------------------------
    // convert quaternion to rotation matrix
    //-------------------------------
    Eigen::Matrix3f r_ref2fin;
    Eigen::Matrix3f t_ref_2_enu;
    r_ref2fin = q_ref2fin.normalized().toRotationMatrix().cast<float>();
    //std::cout << std::endl<< r_ref2fin <<std::endl << '\n';

    t_ref_2_enu << 1.0,0.0,0.0,
            0.0,1.0,0.0,
            0.0,0.0,1.0;
    Eigen::Vector3f pxyz(target_xyz_rel_2_radar.x,
                         target_xyz_rel_2_radar.y,
                         target_xyz_rel_2_radar.z);

    //std::cout << std::endl<< pxyz <<std::endl << '\n';
    Eigen::Vector3f penu;
    penu = t_ref_2_enu*r_ref2fin*pxyz;
    //std::cout << std::endl<< penu <<std::endl << '\n';
    target_enu_rel_2_radar.x = penu[0]; // EAST
    target_enu_rel_2_radar.y = penu[1]; // NORTH
    target_enu_rel_2_radar.z = penu[2]; // UP




    return target_enu_rel_2_radar;
}
/*
--------------------------------------------
name: rotataionMatrixX
goal: rotate by x axis
input: 1. rodtation in deg

output: 1. rotation matrix around x
--------------------------------------------
*/
Eigen::Matrix3f rotataionMatrixX(float deg)
{
    float rad = deg2rad(deg);
    Eigen::Matrix3f rotation_mtrix;
    rotation_mtrix << 1.0,0.0,0.0,
                      0.0,cos(rad),-sin(rad),
                      0.0,sin(rad),cos(rad);
    return rotation_mtrix;

}

/*
--------------------------------------------
name: rotataionMatrixY
goal: rotate by y axis
input: 1. rodtation in deg

output: 1. rotation matrix around y
--------------------------------------------
*/
Eigen::Matrix3f rotataionMatrixY(float deg)
{
    float rad = deg2rad(deg);
    Eigen::Matrix3f rotation_mtrix;
    rotation_mtrix << cos(rad),0.0,sin(rad),
                      0.0,1.0,0.0,
                      -sin(rad),0.0,cos(rad);
    return rotation_mtrix;

}

/*
--------------------------------------------
name: rotataionMatrixZ
goal: rotate by z axis
input: 1. rodtation in deg

output: 1. rotation matrix around z
--------------------------------------------
*/
Eigen::Matrix3f rotataionMatrixZ(float deg)
{
    float rad = deg2rad(deg);
    Eigen::Matrix3f rotation_mtrix;
    rotation_mtrix << cos(rad),-sin(rad),0.0,
                      sin(rad),cos(rad),0.0,
                      0.0,0.0,1.0;
    return rotation_mtrix;

}
/*
--------------------------------------------
name: eulerAngels2RotationMatrix
goal: convert rotation YPR to rotaiotn matrix
input: 1. roll, pitch , yae

output: 1. rotation matrix YPR
--------------------------------------------
*/
Eigen::Matrix3f eulerAngels2RotationMatrix(float roll, float pitch, float yaw)
{
    Eigen::Matrix3f rotation_matrix_x = rotataionMatrixX(roll);
    Eigen::Matrix3f rotation_matrix_y = rotataionMatrixY(pitch);
    Eigen::Matrix3f rotation_matrix_z = rotataionMatrixZ(yaw);
    Eigen::Matrix3f rotation_matrix_ypr = rotation_matrix_z*rotation_matrix_y*rotation_matrix_x;
    return rotation_matrix_ypr;

}


/*
--------------------------------------------
name: convertRadarXyz2EnuByUavTelemetry
goal: convert from xyz to ENU (east-north-up) coordinates relative to radar.
input: 1. Pose3D target_xyz_rel_2_radar
       2. Quaternion q_ref2fin
output: 1. Pose3D  target_enu_rel_2_radar
--------------------------------------------
*/
Pose3D convertRadarXyz2EnuByUavTelemetry(Pose3D target_xyz_rel_2_radar,
                                         float telem_roll,
                                         float telem_pitch,
                                         float telem_yaw,
                                         float setup_roll,
                                         float setup_pitch,
                                         float setup_yaw)
{

    Pose3D  target_enu_rel_2_radar;
    Eigen::Vector3f target_enu_rel_2_radar_vector;
    Eigen::Vector3f target_xyz_rel_2_radar_vector(target_xyz_rel_2_radar.x,
                                                  target_xyz_rel_2_radar.y,
                                                  target_xyz_rel_2_radar.z);

    //-------------------------------------------------------------
    // step 1: Construct rotation matrix ENU -> NED
    // step 1.1 rotate by 180[deg] around X
    // step 1.2 rotate by -90[deg] around Z
    //-------------------------------------------------------------
    Eigen::Matrix3f rotation_mat_enu_2_ned;
    rotation_mat_enu_2_ned = rotataionMatrixX(180.0)*rotataionMatrixZ(-90.0);
    //-------------------------------------------------------------
    // step 2: Construct rotation matrix from Telemetry data
    // get data from platfrom telemetry: NED - > FRD
    //-------------------------------------------------------------
    Eigen::Matrix3f rotation_mat_ned_2_frd;
    rotation_mat_ned_2_frd = eulerAngels2RotationMatrix(telem_roll,telem_pitch,telem_yaw);
    //-------------------------------------------------------------
    // step 3: Convert FRD -> Radar default coordinate system (LUF)
    //
    //  \    /                       ^ F
    //   \  /    ^                   |
    //    \/     |    |------| L <---o U
    //    /\
    //   /  \
    //  /    \
    // step 3.1: rotate by -90[deg] around Z (FRD -> LFD)
    // step 3.2: rotate by -90[deg] around X (LFD -> LUF)
    //-------------------------------------------------------------
    Eigen::Matrix3f rotation_mat_frd_2_luf;
    rotation_mat_frd_2_luf = rotataionMatrixZ(-90)*rotataionMatrixX(-90.0);
    //-------------------------------------------------------------
    // step 4: Convert Radar default  -> Radar setup
    // convert from radar default coordinate system (LUF) to
    // radar setup (instalation) config. The rotation order is YPR
    // note: because the intuitive axis is not LUF so the input from user
    // used as follow: Y(yaw)P(roll)R(pitch)
    //-------------------------------------------------------------
    Eigen::Matrix3f rotation_mat_luf_2_radar_setup;
    rotation_mat_luf_2_radar_setup = rotataionMatrixZ(0.0)*
                                     rotataionMatrixY(-setup_yaw)*
                                     rotataionMatrixX(-setup_pitch);

    target_enu_rel_2_radar_vector = rotation_mat_enu_2_ned*
                                    rotation_mat_ned_2_frd*
                                    rotation_mat_frd_2_luf*
                                    rotation_mat_luf_2_radar_setup*
                                    target_xyz_rel_2_radar_vector;


    target_enu_rel_2_radar.x = target_enu_rel_2_radar_vector[0];
    target_enu_rel_2_radar.y = target_enu_rel_2_radar_vector[1];
    target_enu_rel_2_radar.z = target_enu_rel_2_radar_vector[2];

    return target_enu_rel_2_radar;


}


/*
--------------------------------------------
name: convertEnu2GeoManual
goal: convert from  ENU (east-north-up) coordinates to Geo.
input: 1. Pose3D ENU
       2. GeoPose drone position
output: 1. GeoPose target posiiton
--------------------------------------------
*/
GeoPose convertEnu2GeoManual(Pose3D target_enu ,GeoPose drone_pose)
{
    GeoPose target_geo;

    float r_earth = 6371000.0; //radius of earth[m]
    float r_relative = r_earth*cos(deg2rad(drone_pose.latitude));//[m]
    target_geo.longtitude = rad2deg((target_enu.x/r_relative)+deg2rad(drone_pose.longtitude));
    target_geo.latitude = rad2deg((target_enu.y/r_relative)+deg2rad(drone_pose.latitude));
    target_geo.altitude = float(drone_pose.altitude) + float(target_enu.z);
    return target_geo;

}





/*
--------------------------------------------
name: calculateTimeZone
goal: find UTM zone
input: 1. drone latitude (float)
output: 1. UTM zone (int)
--------------------------------------------
*/
int calculateTimeZone(float latitude, float longitude)
{

    int zone = int((longitude + 180) / 6) + 1;

    if (latitude >= 56.0 && latitude < 64.0 && longitude >= 3.0 && longitude < 12.0)
    {
        zone = 32;
    }

    // Special zones for Svalbard
    if (latitude >= 72.0 && latitude < 84.0)
    {
        if (longitude >= 0.0 && longitude < 9.0) zone = 31;
        else if (longitude >= 9.0 && longitude < 21.0) zone = 33;
        else if (longitude >= 21.0 && longitude < 33.0) zone = 35;
        else if (longitude >= 33.0 && longitude < 42.0) zone = 37;
    }


    return zone;
}

/*
--------------------------------------------
name: calculateTimeZone
goal: find UTM zone
input: 1. drone latitude (float)
output: 1. UTM zone (int)
--------------------------------------------
*/
int checkSouthernHemisphere(float lon)
{
    bool south_hemisphere ;

    if (lon < 0.0)
    {
        south_hemisphere = true;
    }
    else
    {
        south_hemisphere = false;
    }

    return south_hemisphere;
}

/*
--------------------------------------------
name: convertGeo2UTM
goal: convert from  Geo coordinates to UTM.
input: 1. GeoPoint geo coordinates
       2. int utm_zone
output: 1. Pose3D utm pose
--------------------------------------------
*/
Pose3D convertGeo2UTM(GeoPose geo_pose,int utm_zone)
{
    double x_utm , y_utm;
    Pose3D utm_pose ;
    LatLonToUTMXY(geo_pose.latitude,geo_pose.longtitude,utm_zone,x_utm,y_utm);
    utm_pose.x = x_utm;
    utm_pose.y = y_utm;

    return utm_pose;

}

/*
--------------------------------------------
name: convertRelativeEnu2UTM
goal: convert from  ENU (rel to utm pose) to  UTM.
input: 1. Pose3D enu pose , Pose3D referenct_point_utm
output: 1. Pose3D utm pose
--------------------------------------------
*/
Pose3D convertRelativeEnu2UTM(Pose3D enu_pose, Pose3D ref_p_utm)
{
    Pose3D utm_pose;
    utm_pose.x = ref_p_utm.x + enu_pose.x;
    utm_pose.y = ref_p_utm.y + enu_pose.y;

    return utm_pose;

}

/*
--------------------------------------------
name: convertUTM2Geo
goal: convert from  UTM to Geo.
input: 1. Pose3D utm pose, int utm_zone,bool southern_hemisphere
output: 1. GeoPose geo pose
--------------------------------------------
*/
GeoPose convertUTM2Geo(Pose3D utm_pose,int utm_zone,bool southern_hemisphere)
{
    GeoPose geo_pose;
    double latitude,longitude;

    UTMXYToLatLon(utm_pose.x,utm_pose.y,utm_zone,southern_hemisphere,latitude,longitude);

    geo_pose.latitude = rad2deg(latitude);
    geo_pose.longtitude = rad2deg(longitude);

    return geo_pose;
}

/*
--------------------------------------------
name: convertEnu2GeoUtmClass
goal: convert from  ENU (east-north-up) coordinates to Geo.
input: 1. Pose3D ENU
       2. GeoPose drone position
output: 1. GeoPose target posiiton
--------------------------------------------
*/
GeoPose convertEnu2GeoUtmClass(Pose3D target_enu ,GeoPose drone_pose)
{
    GeoPose target_geo;

    //-----------------------------------
    // convert target ENU to Geo
    // step 1: calculate UTM zone and side of sphare
    // step 2: convert uav Geo to UTM
    // step 3: convert ENU to Geo
    //-----------------------------------

    // step 1: calculate UTM zone and side of sphare
    int utm_zone = calculateTimeZone(drone_pose.latitude,drone_pose.longtitude);
    bool southern_hemisphere = checkSouthernHemisphere(drone_pose.latitude);

    // step 2: convert uav Geo to UTM
    Pose3D drone_pose_utm, target_utm;
    drone_pose_utm = convertGeo2UTM(drone_pose,utm_zone);

    // step 2.1: convert target ENU to UTM

    target_utm = convertRelativeEnu2UTM(target_enu,drone_pose_utm);

    target_geo = convertUTM2Geo(target_utm,utm_zone,southern_hemisphere);

    //----------------------------------
    // calculate target altitude
    //----------------------------------
    target_geo.altitude = float(drone_pose.altitude) + float(target_enu.z);


    return target_geo;

}



/*
--------------------------------------------
name: convertRadarAzElR2Geo
goal: convert from radar coordinates to Geo pose
input: 1. float uav_lat
       2. float uav_long
       2. float uav_alt
       3. float q_ref2fin_w
       4. float q_ref2fin_x
       5. float q_ref2fin_y
       6. float q_ref2fin_z
       7. float target_az
       8. float target_el
       9. float target_range
output: 1. float target_lat
        2. float target_long
        3. float target_alt
--------------------------------------------

 */
// float *
float * convertRadarAzElR2Geo(float uav_latitude, float uav_longtitude, float uav_altitude,
                              float q_ref2fin_w, float q_ref2fin_x, float q_ref2fin_y, float q_ref2fin_z,
                              float target_az, float target_el, float target_range)
{


    Eigen::Quaterniond q_ref2fin ;
    q_ref2fin.w() = q_ref2fin_w;
    q_ref2fin.x() = q_ref2fin_x;
    q_ref2fin.y() = q_ref2fin_y;
    q_ref2fin.z() = q_ref2fin_z;
    GeoPose uav_position ;
    uav_position.altitude = uav_altitude;
    uav_position.latitude = uav_latitude;
    uav_position.longtitude = uav_longtitude;

    std::cout << "target azimuth,elevation and range: " << "azimuth: " << target_az <<
                 " , " <<
                 "elevation: " <<target_el <<" , " <<
                 "range: " <<target_range<< "\n";


    //-------------------------------------------------------------
    // step 1: convert radar azimute-elevation-range -> radar XYZ
    //-------------------------------------------------------------
    Pose3D target_xyz_rel_2_radar;
    target_xyz_rel_2_radar = convertRadarAzElR2XYZ(target_az,target_el,target_range);
    std::cout << "target xyz rel 2 radar: " << target_xyz_rel_2_radar.x << " , " <<
                 target_xyz_rel_2_radar.y <<" , " <<
                 target_xyz_rel_2_radar.z<< "\n";

    //-------------------------------------------------------------
    // step 2: convert target coordinates in XYZ relative to radar to ENU rel to radar
    //-------------------------------------------------------------
    Pose3D target_enu_rel_2_radar;
    target_enu_rel_2_radar = convertRadarXyz2Enu(target_xyz_rel_2_radar,q_ref2fin);

    std::cout << "target ENU rel 2 radar: " << target_enu_rel_2_radar.x <<" , "<<
                 target_enu_rel_2_radar.y <<" , "<<
                 target_enu_rel_2_radar.z << '\n';

    //-------------------------------------------------------------
    // step 3: convert ENU coordinates to Geo:
    //-------------------------------------------------------------
    GeoPose target_geo ;
    target_geo = convertEnu2GeoUtmClass(target_enu_rel_2_radar,uav_position);

    std::cout << "target GEO: " << "latitude: "<<target_geo.latitude <<" , "<<
                 "longitude: " <<target_geo.longtitude <<" , "<<
                 "altitude: " << target_geo.altitude << '\n';


    std::cout << "uav GEO: " << "latitude: "<<uav_position.latitude <<" , "<<
                 "longitude: " <<uav_position.longtitude <<" , "<<
                 "altitude: " << uav_position.altitude << '\n';

    float ret[3] = {target_geo.latitude,
                    target_geo.longtitude,
                    target_geo.altitude};
    return ret;




}
/*
--------------------------------------------
name: convertRadarAzElR2GeoTelemFromUav
goal: convert from radar coordinates to Geo pose
input: 1. float uav_lat
       2. float uav_long
       3. float uav_alt
       4. float target_az
       5. float target_el
       6. float target_range
       7. float telem_roll
       8. float telem_pitch
       9. float telem_yaw
       10. float setup_roll
       11. float setup_pitch
       12. float setup_yaw
output: 1. float target_lat
        2. float target_long
        3. float target_alt
--------------------------------------------

 */
wrapTransform convertRadarAzElR2GeoTelemFromUav(float uav_latitude, float uav_longtitude, float uav_altitude,
                                          float target_az, float target_el, float target_range,
                                          float telem_roll, float telem_pitch, float telem_yaw ,
                                          float setup_roll, float setup_pitch, float setup_yaw ){

    wrapTransform wrapper;
    GeoPose uav_position ;
    uav_position.altitude = uav_altitude;
    uav_position.latitude = uav_latitude;
    uav_position.longtitude = uav_longtitude;
    //-------------------------------------------------------------
    // step 1: convert radar azimute-elevation-range -> radar XYZ
    //-------------------------------------------------------------
    Pose3D target_xyz_rel_2_radar;
    target_xyz_rel_2_radar = convertRadarAzElR2XYZ(target_az,target_el,target_range);
//    std::cout << "target xyz rel 2 radar: " << target_xyz_rel_2_radar.x << " , " <<
//                 target_xyz_rel_2_radar.y <<" , " <<
//                 target_xyz_rel_2_radar.z<< "\n";
    //-------------------------------------------------------------
    // step 2: convert target coordinates in XYZ relative to radar to ENU rel to radar
    //-------------------------------------------------------------
    Pose3D target_enu_rel_2_radar;
    target_enu_rel_2_radar = convertRadarXyz2EnuByUavTelemetry(target_xyz_rel_2_radar,
                                                               telem_roll,
                                                               telem_pitch,
                                                               telem_yaw,
                                                               setup_roll,
                                                               setup_pitch,
                                                               setup_yaw);

//    std::cout << "target ENU rel 2 radar: " << target_enu_rel_2_radar.x <<" , "<<
//                 target_enu_rel_2_radar.y <<" , "<<
//                 target_enu_rel_2_radar.z << '\n';

    //-------------------------------------------------------------
    // step 3: convert ENU coordinates to Geo:
    //-------------------------------------------------------------
    GeoPose target_geo ;
    target_geo = convertEnu2GeoUtmClass(target_enu_rel_2_radar,uav_position);

//    std::cout << "target GEO: " << "latitude: "<<target_geo.latitude <<" , "<<
//                 "longitude: " <<target_geo.longtitude <<" , "<<
//                 "altitude: " << target_geo.altitude << '\n';


//    std::cout << "uav GEO: " << "latitude: "<<uav_position.latitude <<" , "<<
//                 "longitude: " <<uav_position.longtitude <<" , "<<
//                 "altitude: " << uav_position.altitude << '\n';

    wrapper.transformation[0] = target_geo.latitude;
    wrapper.transformation[1] = target_geo.longtitude;
    wrapper.transformation[2] = target_geo.altitude;
    return wrapper;
}
