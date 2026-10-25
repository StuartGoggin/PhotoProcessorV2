// Own hidden test window only; never enumerates/operates another application.
// This translation unit and its executable are excluded from user delivery.
#define wmain unused_picture_runner_entry
#include "main.cpp"
#undef wmain
int wmain() {
    using namespace picture_handoff;
    GuiState ui;WNDCLASSW kind{};kind.lpfnWndProc=gui_proc;kind.hInstance=GetModuleHandleW(nullptr);kind.lpszClassName=L"PhotoGoGoOwnedGuiFixture";
    if(!RegisterClassW(&kind))return 1;
    const HWND window=CreateWindowExW(0,kind.lpszClassName,L"Hidden owned fixture",WS_OVERLAPPED,
        0,0,700,505,nullptr,nullptr,kind.hInstance,&ui);
    if(!window||ui.running||ui.finished||IsWindowEnabled(ui.start)||IsWindowEnabled(ui.cancel)||IsWindowEnabled(ui.open))return 1;
    const auto start=GetTickCount64();ui.running=true;ui.closeRequested=true;cancelled=true;
    ui.worker=std::thread([&ui] {
        {std::lock_guard<std::mutex> guard(ui.mutex);ui.phase=L"Stopped: CANCELLED. No success claim.";}
        ui.terminalReady=true;
        // Deliberately no PostMessage. Timer is the independent authority.
    });
    while(!ui.terminalReady&&GetTickCount64()-start<1000)Sleep(1);
    SendMessageW(window,WM_TIMER,1,0);
    const bool stopped=ui.finished&&!ui.running&&!ui.worker.joinable()&&!IsWindow(window);
    std::cout<<"{\"event\":\"ownedHiddenGuiFixture\",\"initialRunDisabled\":true,\"noAutomaticRender\":true,\"notificationSuppressed\":true,\"cancelledTimerReachedTerminal\":"
        <<(stopped?"true":"false")<<",\"productionExportQualified\":false}\n";
    return stopped?0:1;
}
