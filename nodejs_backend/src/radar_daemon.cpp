#include <iostream>
#include <cstddef>




#include <string>
#include <vector>
#include <thread>
#include <chrono>
#include <bnet_interface.h>

void readCommands(bnet_interface& bnet, const std::string& radarId) {
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line == "CMD:EXIT") {
            break;
        }
    }
}

int main(int argc, char* argv[]) {
    if (argc < 4) {
        std::cerr << "Usage: radar_daemon.exe <IP> <PORT> <RADAR_ID>" << std::endl;
        return 1;
    }

    std::string ip = argv[1];
    int port = std::stoi(argv[2]);
    std::string radarId = argv[3];

    bnet_interface bnet;
    try {
        bnet.connect(ip, port, "C:\\temp");
        
        bnet.set_collect(mesa_data_t::TRACK_DATA, true);
        bnet.set_collect(mesa_data_t::STATUS_DATA, true);
        
    } catch (const std::exception& e) {
        std::cerr << "Error connecting to radar: " << e.what() << std::endl;
        return 1;
    }

    std::cout << "{\"type\":\"status\",\"radarId\":\"" << radarId << "\",\"message\":\"Connected to radar " << radarId << " at " << ip << "\"}" << std::endl;

    // Start a thread to read commands from stdin
    std::thread commandThread(readCommands, std::ref(bnet), radarId);

    try {
        // Main polling loop
        while (true) {
            auto n_track = bnet.get_n_buffered(TRACK_DATA);
            while (n_track > 0) {
                MESAK_Track&& packet = bnet.get_track();
                if (packet.header != nullptr && packet.header->nTracks > 0) {

                    for (size_t t = 0; t < packet.data.size(); t++) {
                        const track_data& td = packet.data[t];
                        
                        std::cout << "{\"type\":\"track\","
                                  << "\"radarId\":\"" << radarId << "\","
                                  << "\"id\":" << td.ID << ","
                                  << "\"x\":" << td.xest << ","
                                  << "\"y\":" << td.yest << ","
                                  << "\"z\":" << td.zest << ","
                                  << "\"azest\":" << td.azest << ","
                                  << "\"elest\":" << td.elest << ","
                                  << "\"rest\":" << td.rest << ","
                                  << "\"speedX\":" << td.velxest << ","
                                  << "\"speedY\":" << td.velyest << ","
                                  << "\"speedZ\":" << td.velzest << ","
                                  << "\"probUAV\":" << td.probabilityUAV << ","
                                  << "\"confidence\":" << td.estConfidence << ","
                                  << "\"rcs\":" << td.estRCS << "}" << std::endl;
                    }
                }
                n_track = bnet.get_n_buffered(TRACK_DATA);
            }

            auto n_status = bnet.get_n_buffered(STATUS_DATA);
            while (n_status > 0) {
                MESAK_Status&& statusPacket = bnet.get_status();
                if (statusPacket.data != nullptr) {
                    std::cout << "{\"type\":\"imu\","
                              << "\"radarId\":\"" << radarId << "\","
                              << "\"quat_x\":" << statusPacket.data->quat_x << ","
                              << "\"quat_y\":" << statusPacket.data->quat_y << ","
                              << "\"quat_z\":" << statusPacket.data->quat_z << ","
                              << "\"quat_w\":" << statusPacket.data->quat_w << "}" << std::endl;
                }
                n_status = bnet.get_n_buffered(STATUS_DATA);
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    } catch (const std::exception& e) {
        std::cerr << "{\"type\":\"error\",\"message\":\"" << e.what() << "\"}" << std::endl;
    } catch (...) {
        std::cerr << "{\"type\":\"error\",\"message\":\"Unknown fatal error in main loop\"}" << std::endl;
    }

    commandThread.detach(); // Detach instead of join to allow graceful exit if main loop crashes
    return 1;
}
