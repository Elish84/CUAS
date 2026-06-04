cmake_minimum_required(VERSION 3.16)
project(RadarBackend VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

# Find Qt Core, Network, and WebSockets
find_package(Qt6 COMPONENTS Core Network WebSockets REQUIRED)

# Add BNET API includes (adjust path if needed)
include_directories(../BNET_11_1_5_Windows_API/API/include)

# Gather source files
file(GLOB_RECURSE SOURCES 
    "Devices/RadarDevice/*.cpp" 
    "Devices/WebSocketMgr/*.cpp"
    "Common/*.cpp"
    "UTM/*.cpp"
    "main.cpp"
)

# Note: In a real environment, you might exclude the DDS specific files or wrap them
# if RTI Connext DDS is not installed on the system.

add_executable(${PROJECT_NAME} ${SOURCES})

target_link_libraries(${PROJECT_NAME} PRIVATE
    Qt6::Core
    Qt6::Network
    Qt6::WebSockets
)
