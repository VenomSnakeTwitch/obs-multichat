#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>

#include <filesystem>
#include <string>

struct obs_module;
struct QWidget;
struct QCefWidget;
struct QCefCookieManager;

// First virtual methods of the obs-browser v3 panel interface on Windows/MSVC.
struct QCef {
    virtual ~QCef() = default;
    virtual bool init_browser() = 0;
    virtual bool initialized() = 0;
    virtual bool wait_for_browser_init() = 0;
    virtual QCefWidget *create_widget(QWidget *, const std::string &, QCefCookieManager *) = 0;
};

extern "C" {
__declspec(dllimport) void blog(int, const char *, ...);
__declspec(dllimport) void bfree(void *);
__declspec(dllimport) obs_module *obs_get_module(const char *);
__declspec(dllimport) void *obs_get_module_lib(obs_module *);
__declspec(dllimport) const char *obs_get_module_binary_path(obs_module *);
__declspec(dllimport) char *obs_module_get_config_path(obs_module *, const char *);
__declspec(dllimport) bool obs_frontend_add_dock_by_id(const char *, const char *, void *);
}

namespace {
constexpr wchar_t localAddress[] = L"127.0.0.1";
constexpr INTERNET_PORT port = 17834;
constexpr char dockUrl[] = "http://127.0.0.1:17834/";
constexpr char dockId[] = "org.venomsnake.multichat";
constexpr int warning = 200;
constexpr int info = 300;
obs_module *module = nullptr;
HANDLE workerJob = nullptr;
HANDLE workerProcess = nullptr;
DWORD workerId = 0;

std::wstring quote(const std::filesystem::path &path)
{
    return L"\"" + path.wstring() + L"\"";
}

void stop_worker()
{
    if (workerJob) {
        CloseHandle(workerJob);
        workerJob = nullptr;
    }
    if (workerProcess) {
        WaitForSingleObject(workerProcess, 1000);
        CloseHandle(workerProcess);
        workerProcess = nullptr;
    }
}

bool start_worker()
{
    const char *binary = obs_get_module_binary_path(module);
    char *config = obs_module_get_config_path(module, "channels.json");
    if (!binary || !config) {
        bfree(config);
        return false;
    }

    const std::filesystem::path data = std::filesystem::absolute(std::filesystem::u8path(binary)).parent_path() / L"data";
    const std::filesystem::path settings = std::filesystem::absolute(std::filesystem::u8path(config));
    bfree(config);
    const auto node = data / L"node.exe";
    auto command = quote(node) + L" " + quote(data / L"server.cjs") + L" " + quote(settings);

    workerJob = CreateJobObjectW(nullptr, nullptr);
    if (!workerJob)
        return false;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(workerJob, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        return false;

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, data.c_str(), &startup, &process))
        return false;

    workerProcess = process.hProcess;
    workerId = process.dwProcessId;
    const bool started = AssignProcessToJobObject(workerJob, workerProcess) &&
                         ResumeThread(process.hThread) != static_cast<DWORD>(-1);
    if (!started)
        TerminateProcess(workerProcess, 1);
    CloseHandle(process.hThread);
    return started;
}

void size_dock(QCefWidget *browser)
{
    // Use the Qt runtime already loaded by OBS 33 on Windows x64.
    HMODULE qt = GetModuleHandleW(L"Qt6Widgets.dll");
    if (!qt)
        return;
    using WidgetSize = void (*)(QWidget *, int, int);
    using WidgetWindow = QWidget *(*)(const QWidget *);
    const auto minimum = reinterpret_cast<WidgetSize>(GetProcAddress(qt, "?setMinimumSize@QWidget@@QEAAXHH@Z"));
    const auto resize = reinterpret_cast<WidgetSize>(GetProcAddress(qt, "?resize@QWidget@@QEAAXHH@Z"));
    const auto window = reinterpret_cast<WidgetWindow>(GetProcAddress(qt, "?window@QWidget@@QEBAPEAV1@XZ"));
    auto *widget = reinterpret_cast<QWidget *>(browser);
    if (minimum)
        minimum(widget, 340, 360);
    if (resize && window) {
        if (auto *dock = window(widget))
            resize(dock, 460, 640);
    }
}

bool wait_until_ready()
{
    HINTERNET session = WinHttpOpen(L"OBS Multi-Chat", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session)
        return false;
    WinHttpSetTimeouts(session, 250, 250, 250, 250);
    HINTERNET connection = WinHttpConnect(session, localAddress, port, 0);
    const std::wstring route = L"/ready-" + std::to_wstring(workerId);
    bool ready = false;
    if (connection) {
        const ULONGLONG deadline = GetTickCount64() + 6500;
        while (!ready && GetTickCount64() < deadline &&
               WaitForSingleObject(workerProcess, 0) == WAIT_TIMEOUT) {
            HINTERNET request = WinHttpOpenRequest(connection, L"GET", route.c_str(), nullptr,
                                                   WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
            if (request) {
                DWORD status = 0;
                DWORD size = sizeof(status);
                ready = WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                           WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
                        WinHttpReceiveResponse(request, nullptr) &&
                        WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX) &&
                        status == 204;
                WinHttpCloseHandle(request);
            }
            if (!ready)
                Sleep(50);
        }
        WinHttpCloseHandle(connection);
    }
    WinHttpCloseHandle(session);
    return ready;
}
}

#define OBS_EXPORT extern "C" __declspec(dllexport)
OBS_EXPORT void obs_module_set_pointer(obs_module *pointer) { module = pointer; }
OBS_EXPORT unsigned obs_module_ver() { return 0x21000001; }
OBS_EXPORT const char *obs_module_name() { return "OBS Multi-Chat"; }
OBS_EXPORT const char *obs_module_description() { return "Twitch and TikTok LIVE chat dock"; }

OBS_EXPORT bool obs_module_load()
{
    try {
        if (start_worker())
            return true;
    } catch (const std::exception &error) {
        blog(warning, "[Multi-Chat] Worker setup: %s", error.what());
    }
    const DWORD error = GetLastError();
    stop_worker();
    blog(warning, "[Multi-Chat] Worker could not start (Windows error %lu).", error);
    return false;
}

OBS_EXPORT void obs_module_post_load()
{
    obs_module *browser = obs_get_module("obs-browser");
    HMODULE library = browser ? static_cast<HMODULE>(obs_get_module_lib(browser)) : nullptr;
    using Version = int (*)();
    using CreatePanel = QCef *(*)();
    const auto version = library ? reinterpret_cast<Version>(
        GetProcAddress(library, "obs_browser_qcef_version_export")) : nullptr;
    const auto create = library ? reinterpret_cast<CreatePanel>(
        GetProcAddress(library, "obs_browser_create_qcef")) : nullptr;
    if (!version || version() != 3 || !create) {
        blog(warning, "[Multi-Chat] Compatible OBS Browser panel was not found.");
        stop_worker();
        return;
    }
    if (!wait_until_ready()) {
        DWORD code = 0;
        GetExitCodeProcess(workerProcess, &code);
        blog(warning, "[Multi-Chat] Local worker did not become ready on port %u (exit code %lu).", static_cast<unsigned>(port), code);
        stop_worker();
        return;
    }
    QCef *panel = create();
    if (!panel) {
        blog(warning, "[Multi-Chat] OBS Browser panel could not be initialized.");
        stop_worker();
        return;
    }
    panel->init_browser();
    QCefWidget *widget = panel->create_widget(nullptr, dockUrl, nullptr);
    if (!widget || !obs_frontend_add_dock_by_id(dockId, "Twitch + TikTok Chat (Multi-Chat)", widget)) {
        blog(warning, "[Multi-Chat] Dock could not be registered.");
        stop_worker();
        return;
    }
    size_dock(widget);
    blog(info, "[Multi-Chat] Twitch + TikTok Chat (Multi-Chat) dock registered.");
}

OBS_EXPORT void obs_module_unload() { stop_worker(); }




