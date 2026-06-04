#include <napi.h>
#include <bnet_interface.h>
#include <map>
#include <string>

std::map<std::string, bnet_interface*> radarInstances;

Napi::Value Connect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsString()) {
        Napi::TypeError::New(env, "String ip, Number port, String radarId expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string ip = info[0].As<Napi::String>().Utf8Value();
    int port = info[1].As<Napi::Number>().Int32Value();
    std::string radarId = info[2].As<Napi::String>().Utf8Value();

    try {
        if (radarInstances.find(radarId) != radarInstances.end()) {
            delete radarInstances[radarId];
        }

        bnet_interface* bnet = new bnet_interface();
        bnet->connect(ip, port, "");
        bnet->set_collect(mesa_data_t::TRACK_DATA, true);
        bnet->set_collect(mesa_data_t::STATUS_DATA, true);
        
        radarInstances[radarId] = bnet;
        return Napi::Boolean::New(env, true);
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

Napi::Value Disconnect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        return env.Null();
    }
    std::string radarId = info[0].As<Napi::String>().Utf8Value();
    
    if (radarInstances.find(radarId) != radarInstances.end()) {
        radarInstances[radarId]->disconnect();
        delete radarInstances[radarId];
        radarInstances.erase(radarId);
    }
    return env.Null();
}

Napi::Value GetTracks(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "String radarId expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string radarId = info[0].As<Napi::String>().Utf8Value();

    if (radarInstances.find(radarId) == radarInstances.end()) {
        return Napi::Array::New(env);
    }

    bnet_interface* bnet = radarInstances[radarId];
    auto n_track = bnet->get_n_buffered(TRACK_DATA);
    
    Napi::Array results = Napi::Array::New(env);
    int count = 0;

    for (size_t i = 0; i < n_track; i++) {
        MESAK_Track packet = bnet->get_track();
        if (packet.header->nTracks == 0) continue;

        for (size_t t = 0; t < packet.data.size(); t++) {
            const track_data& td = packet.data[t];
            Napi::Object obj = Napi::Object::New(env);
            
            obj.Set("id", Napi::Number::New(env, td.ID));
            obj.Set("lat", Napi::Number::New(env, td.yest)); // Mapping x, y, z to lat/lng depends on coordinate transforms, we pass raw for now
            obj.Set("lng", Napi::Number::New(env, td.xest));
            obj.Set("alt", Napi::Number::New(env, td.zest));
            obj.Set("speed", Napi::Number::New(env, td.velxest)); // Simplified
            obj.Set("classification", Napi::Number::New(env, td.probabilityUAV > 0.5 ? 1 : 0));
            obj.Set("confidence", Napi::Number::New(env, td.estConfidence));
            obj.Set("heading", Napi::Number::New(env, 0)); // Calculate heading if needed
            
            results.Set(count++, obj);
        }
    }

    return results;
}

Napi::Value SendCommand(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        return env.Null();
    }
    std::string radarId = info[0].As<Napi::String>().Utf8Value();
    std::string cmd = info[1].As<Napi::String>().Utf8Value();

    if (radarInstances.find(radarId) != radarInstances.end()) {
        radarInstances[radarId]->send_command(cmd);
    }
    return env.Null();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "connect"), Napi::Function::New(env, Connect));
    exports.Set(Napi::String::New(env, "disconnect"), Napi::Function::New(env, Disconnect));
    exports.Set(Napi::String::New(env, "getTracks"), Napi::Function::New(env, GetTracks));
    exports.Set(Napi::String::New(env, "sendCommand"), Napi::Function::New(env, SendCommand));
    return exports;
}

NODE_API_MODULE(bnet_addon, Init)
