#Requires -Version 7.0
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$pictureRenameRoot=Join-Path (Split-Path -Parent $PSScriptRoot) ('test-output/report-rename-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $pictureRenameRoot | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PictureRenameFixture {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 private static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr sec,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)]
 private static extern bool SetFileInformationByHandle(SafeFileHandle h,int cls,IntPtr data,uint n);
 public static int Run(string directory,bool relative,bool leaseParent) {
  using(var parent=leaseParent?CreateFileW(directory,0x80000000,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero):new SafeFileHandle(IntPtr.Zero,false))
  using(var file=CreateFileW(Path.Combine(directory,"report.partial"),0xc0010000,1,IntPtr.Zero,1,0x00200000,IntPtr.Zero)) {
   if((leaseParent&&parent.IsInvalid)||file.IsInvalid)throw new InvalidOperationException("Fixture lease failed");
   var name=Encoding.Unicode.GetBytes(relative?"report.json":Path.Combine(directory,"report.json"));
   IntPtr buffer=Marshal.AllocHGlobal(32+name.Length);
   try {
    Marshal.Copy(new byte[32+name.Length],0,buffer,32+name.Length);
    Marshal.WriteIntPtr(buffer,8,relative?parent.DangerousGetHandle():IntPtr.Zero);
    Marshal.WriteInt32(buffer,16,name.Length);Marshal.Copy(name,0,IntPtr.Add(buffer,20),name.Length);
    bool ok=SetFileInformationByHandle(file,3,buffer,(uint)(32+name.Length));return ok?0:Marshal.GetLastWin32Error();
   } finally {Marshal.FreeHGlobal(buffer);}
  }
 }
}
'@
foreach ($pictureLeaseParent in @($false,$true)) {foreach ($pictureRelative in @($false,$true)) {
    $pictureRenameDirectory=Join-Path $pictureRenameRoot ($pictureLeaseParent.ToString()+'-'+$pictureRelative.ToString())
    New-Item -ItemType Directory -Path $pictureRenameDirectory | Out-Null
    [pscustomobject]@{leaseParent=$pictureLeaseParent;relative=$pictureRelative;windowsError=[PictureRenameFixture]::Run($pictureRenameDirectory,$pictureRelative,$pictureLeaseParent)} | ConvertTo-Json -Compress
}}
