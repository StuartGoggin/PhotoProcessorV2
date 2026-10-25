#pragma once
#include "session.h"
#include <shobjidl.h>
#include <shellapi.h>
#include <thread>
namespace picture_handoff {
struct GuiState {
    HWND window=nullptr,status=nullptr,choose=nullptr,start=nullptr,cancel=nullptr,open=nullptr,idle=nullptr;
    HFONT font=nullptr;fs::path parent,result;std::thread worker;std::mutex mutex;
    std::wstring phase=L"Choose a results folder. No test starts automatically.";
    bool running=false,finished=false,complete=false,closeRequested=false;std::atomic<bool> terminalReady{false};uint64_t began=0;
    ~GuiState(){if(worker.joinable())worker.join();if(font)DeleteObject(font);}
};
inline fs::path choose_parent(HWND owner) {
    Microsoft::WRL::ComPtr<IFileOpenDialog> picker;
    if(FAILED(CoCreateInstance(CLSID_FileOpenDialog,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&picker))))
        throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    DWORD options=0;
    if(FAILED(picker->GetOptions(&options))||FAILED(picker->SetOptions(options|FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM))
        ||FAILED(picker->SetTitle(L"Choose a short local folder for a NEW PhotoGoGo test session")))
        throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    const HRESULT result=picker->Show(owner);if(result==HRESULT_FROM_WIN32(ERROR_CANCELLED))return {};
    if(FAILED(result))throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    Microsoft::WRL::ComPtr<IShellItem> item;PWSTR path=nullptr;
    if(FAILED(picker->GetResult(&item))||FAILED(item->GetDisplayName(SIGDN_FILESYSPATH,&path)))
        throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    const fs::path parent(path);CoTaskMemFree(path);return parent;
}
inline fs::path new_session_path(const fs::path& parent) {
    GUID id{};wchar_t text[40]{};
    if(FAILED(CoCreateGuid(&id))||!StringFromGUID2(id,text,40))throw std::runtime_error("REPORT_IDENTIFIER_UNAVAILABLE");
    return parent/(L"PG-Test-"+std::wstring(text+1,8));
}
inline void ui_cancel(GuiState& ui) {
    std::lock_guard<std::mutex> guard(commitMutex);
    if(!committed)cancelled=true;
    EnableWindow(ui.cancel,FALSE);
    SetWindowTextW(ui.status,L"Cancelling this owned test only; waiting for confirmed process cleanup...");
}
inline HWND control(GuiState& ui,const wchar_t* kind,const wchar_t* text,DWORD style,int x,int y,int width,int height,int id=0) {
    const HWND handle=CreateWindowExW(0,kind,text,WS_CHILD|WS_VISIBLE|style,x,y,width,height,ui.window,
        reinterpret_cast<HMENU>(INT_PTR(id)),GetModuleHandleW(nullptr),nullptr);
    if(!handle)throw std::runtime_error("INTERFACE_UNAVAILABLE");
    if(std::wstring(kind)==L"BUTTON")SetWindowLongPtrW(handle,GWL_STYLE,GetWindowLongPtrW(handle,GWL_STYLE)|WS_TABSTOP);
    SendMessageW(handle,WM_SETFONT,reinterpret_cast<WPARAM>(ui.font),TRUE);return handle;
}
inline void finish_ui(GuiState& ui) {
    if(ui.finished||!ui.terminalReady.load())return;
    if(ui.worker.joinable())ui.worker.join();ui.running=false;ui.finished=true;
    {std::lock_guard<std::mutex> guard(ui.mutex);SetWindowTextW(ui.status,ui.phase.c_str());}
    EnableWindow(ui.cancel,FALSE);EnableWindow(ui.open,fs::exists(ui.result));
    if(ui.closeRequested)DestroyWindow(ui.window);
}
inline LRESULT CALLBACK gui_proc(HWND window,UINT message,WPARAM wParam,LPARAM lParam) {
    auto* ui=reinterpret_cast<GuiState*>(GetWindowLongPtrW(window,GWLP_USERDATA));
    if(message==WM_NCCREATE) {
        ui=static_cast<GuiState*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams);
        ui->window=window;SetWindowLongPtrW(window,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(ui));
    }
    if(!ui)return DefWindowProcW(window,message,wParam,lParam);
    try {
        if(message==WM_CREATE) {
            ui->font=CreateFontW(-16,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
            control(*ui,L"STATIC",L"PhotoGoGo subject-finishing test",0,24,18,630,28);
            control(*ui,L"STATIC",L"Four sequential, 2-second UHD cases compare CPU with your NVIDIA GPU.\n"
                L"Uses supplied cached masks and software encoding - not CUDA inference or\n"
                L"NVIDIA video encoding. Quality and production export remain unqualified.\n\n"
                L"Installs nothing. Originals, drivers, settings and active renders are not changed.\n"
                L"Choose a short ordinary local folder (e.g. D:\\Tests), with 512 MiB free.",0,24,55,630,133);
            ui->choose=control(*ui,L"BUTTON",L"Choose results folder...",BS_PUSHBUTTON,24,200,240,34,101);
            ui->idle=control(*ui,L"BUTTON",L"PhotoGoGo and other rendering are idle (my confirmation)",BS_AUTOCHECKBOX,24,248,630,32,100);
            ui->status=control(*ui,L"STATIC",ui->phase.c_str(),0,24,295,630,95);
            ui->start=control(*ui,L"BUTTON",L"Run four tests",BS_PUSHBUTTON,24,405,155,36,102);
            ui->cancel=control(*ui,L"BUTTON",L"Cancel test",BS_PUSHBUTTON,193,405,140,36,103);
            ui->open=control(*ui,L"BUTTON",L"Open results",BS_PUSHBUTTON,347,405,150,36,104);
            EnableWindow(ui->start,FALSE);EnableWindow(ui->cancel,FALSE);EnableWindow(ui->open,FALSE);
            SetTimer(window,1,250,nullptr);return 0;
        }
        if(message==WM_COMMAND) {
            const auto id=LOWORD(wParam);
            if(id==101&&!ui->running&&!ui->finished) {
                const auto parent=choose_parent(window);
                if(!parent.empty()) {
                    const auto target=new_session_path(parent);FileSet guard;guard.ancestry(target);
                    if(target.native().size()+110>240)throw std::runtime_error("ORDINARY_LOCAL_PATH_REQUIRED");
                    ui->parent=parent;ui->result=target;
                    ui->phase=L"Results will use a new PG-Test folder inside:\n"+parent.wstring();SetWindowTextW(ui->status,ui->phase.c_str());
                }
            }
            if(id==100||id==101)EnableWindow(ui->start,!ui->parent.empty()&&SendMessageW(ui->idle,BM_GETCHECK,0,0)==BST_CHECKED);
            if(id==102&&!ui->running&&!ui->finished&&!ui->parent.empty()&&SendMessageW(ui->idle,BM_GETCHECK,0,0)==BST_CHECKED) {
                if(MessageBoxW(window,L"Run ONLY when rendering is idle. This reads supplied samples and creates four bounded test videos.\n\n"
                    L"Each case has a 180-second checkpoint deadline and a 4 GiB owned-job cap. Local blocked disk IO can delay cancellation.\n"
                    L"No installation or production export is performed. Continue?",L"Start the bounded comparison?",MB_OKCANCEL|MB_ICONINFORMATION)!=IDOK)return 0;
                ui->running=true;ui->began=GetTickCount64();EnableWindow(ui->start,FALSE);EnableWindow(ui->choose,FALSE);EnableWindow(ui->idle,FALSE);EnableWindow(ui->cancel,TRUE);
                ui->worker=std::thread([ui] {
                    std::wstring final;bool complete=false;
                    try {
                        complete=run_comparison(ui->result,"nvidia",[ui](unsigned index,const std::wstring& phase) {
                            std::lock_guard<std::mutex> guard(ui->mutex);ui->phase=L"Case "+std::to_wstring(index)+L" of 4: "+phase;
                        });
                        final=(complete?L"Comparison complete.":L"Comparison partial: one or more cases failed. NVIDIA was not substituted.");
                        final+=L"\nAttach PhotoGoGo-Return-Reports.zip here in Codex (no videos).\nQuality and production export are NOT qualified.";
                    } catch(const std::exception& error) {
                        final=L"Stopped: "+fs::path(public_failure(error.what())).wstring()+L". Completed cases remain.\n"
                            L"Open results. From each completed case folder send ONLY picture-report.json\n"
                            L"and its matching .committed file, plus this stop code. Do NOT send MP4s\n"
                            L"or zip the whole results folder. Unfinished cases have no valid marker.";
                    }
                    {std::lock_guard<std::mutex> guard(ui->mutex);ui->phase=final;ui->complete=complete;}
                    ui->terminalReady=true;
                    // Wake-up hint only: timer also observes the authoritative
                    // terminal flag, even when cancellation or posting fails.
                    PostMessageW(ui->window,WM_APP+1,0,0);
                });return 0;
            }
            if(id==103&&ui->running){ui_cancel(*ui);return 0;}
            if(id==104&&!ui->result.empty())ShellExecuteW(window,L"open",ui->result.c_str(),nullptr,nullptr,SW_SHOWNORMAL);
            return 0;
        }
        if(message==WM_TIMER) {
            if(ui->terminalReady){finish_ui(*ui);return 0;}
            if(ui->running&&!cancelled) {
                std::lock_guard<std::mutex> guard(ui->mutex);
                const auto status=ui->phase+L"\nElapsed: "+std::to_wstring((GetTickCount64()-ui->began)/1000)+L" s. No ETA is estimated.";
                SetWindowTextW(ui->status,status.c_str());
            }return 0;
        }
        if(message==WM_APP+1) {
            finish_ui(*ui);return 0;
        }
        if(message==WM_CLOSE) {
            if(ui->running){ui->closeRequested=true;ui_cancel(*ui);}else DestroyWindow(window);return 0;
        }
        if(message==WM_DESTROY){KillTimer(window,1);PostQuitMessage(0);return 0;}
    } catch(const std::exception& error) {
        if(ui->running&&!ui->worker.joinable()){ui->running=false;ui->finished=true;EnableWindow(ui->cancel,FALSE);}
        const auto code=fs::path(public_failure(error.what())).wstring();
        MessageBoxW(window,(L"Could not continue: "+code+L".\nChoose a short ordinary local folder. No driver or policy changes were made.").c_str(),L"PhotoGoGo test",MB_OK|MB_ICONERROR);
        if(message==WM_CREATE)return -1;
    }
    return DefWindowProcW(window,message,wParam,lParam);
}
inline int gui_run() {
    DWORD consoles[2]{};if(GetConsoleProcessList(consoles,2)==1)ShowWindow(GetConsoleWindow(),SW_HIDE);
    if(FAILED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED|COINIT_DISABLE_OLE1DDE)))throw std::runtime_error("INTERFACE_UNAVAILABLE");
    struct ComGuard{~ComGuard(){CoUninitialize();}} guard;GuiState ui;
    WNDCLASSW kind{};kind.lpfnWndProc=gui_proc;kind.hInstance=GetModuleHandleW(nullptr);kind.lpszClassName=L"PhotoGoGoCachedPictureTest";
    kind.hCursor=LoadCursorW(nullptr,IDC_ARROW);kind.hbrBackground=reinterpret_cast<HBRUSH>(COLOR_WINDOW+1);
    if(!RegisterClassW(&kind))throw std::runtime_error("INTERFACE_UNAVAILABLE");
    const HWND window=CreateWindowExW(0,kind.lpszClassName,L"PhotoGoGo - subject finishing comparison",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,
        CW_USEDEFAULT,CW_USEDEFAULT,700,505,nullptr,nullptr,kind.hInstance,&ui);
    if(!window)throw std::runtime_error("INTERFACE_UNAVAILABLE");ShowWindow(window,SW_SHOWNORMAL);
    MSG message{};BOOL result=0;
    while((result=GetMessageW(&message,nullptr,0,0))>0){if(!IsDialogMessageW(window,&message)){TranslateMessage(&message);DispatchMessageW(&message);}}
    if(result<0)throw std::runtime_error("INTERFACE_UNAVAILABLE");return ui.finished?0:2;
}
}
