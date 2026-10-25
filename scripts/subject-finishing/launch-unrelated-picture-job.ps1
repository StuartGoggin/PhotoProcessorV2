#Requires -Version 7.0
param([Parameter(Mandatory)][string]$Binary,[Parameter(Mandatory)][string]$Output)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Development-only controlled OS fixture: ambient job, deliberately no issued mapping.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UnrelatedPictureJob {
 [StructLayout(LayoutKind.Sequential)] struct Startup {
  public uint cb; public IntPtr reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
  public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct Process {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct Basic {
  public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] struct Counters {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] struct Limits {public Basic basic;public Counters io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref Limits limits,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string exe,StringBuilder line,IntPtr a,IntPtr b,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Process process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static uint Run(string binary,string output) {
  if(binary.Contains("\"")||output.Contains("\""))throw new InvalidOperationException("Invalid fixture path");
  IntPtr job=CreateJobObjectW(IntPtr.Zero,null);Process child=new Process();
  try {
   var limits=new Limits();limits.basic.flags=0x2200;limits.jobMemory=new UIntPtr(4UL*1024*1024*1024);
   if(job==IntPtr.Zero||!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<Limits>()))throw new InvalidOperationException("Fixture job failed");
   var startup=new Startup();startup.cb=(uint)Marshal.SizeOf<Startup>();
   var args=new StringBuilder("\""+binary+"\" --owned-render \""+output+"\" black-horse cpu");
   if(!CreateProcessW(binary,args,IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,null,ref startup,out child))throw new InvalidOperationException("Fixture child failed");
   bool member;
   if(!AssignProcessToJobObject(job,child.process)||!IsProcessInJob(child.process,job,out member)||!member)throw new InvalidOperationException("Fixture ownership failed");
   if(ResumeThread(child.thread)==uint.MaxValue||WaitForSingleObject(child.process,30000)!=0)throw new InvalidOperationException("Fixture child deadline failed");
   uint code;if(!GetExitCodeProcess(child.process,out code))throw new InvalidOperationException("Fixture result failed");return code;
  } finally {
   if(job!=IntPtr.Zero)TerminateJobObject(job,1);
   if(child.process!=IntPtr.Zero){TerminateProcess(child.process,1);WaitForSingleObject(child.process,2500);CloseHandle(child.process);}
   if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(job!=IntPtr.Zero)CloseHandle(job);
  }
 }
}
'@
$pictureExit=[UnrelatedPictureJob]::Run([IO.Path]::GetFullPath($Binary),[IO.Path]::GetFullPath($Output))
[pscustomobject]@{event='unrelatedJobFixture';verifiedAmbientJob=$true;issuedInput=$false;childExit=$pictureExit} | ConvertTo-Json -Compress
