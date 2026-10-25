#Requires -Version 7.0
param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Development-only OS-seam fixture. Holds a write-capable handle; changes no files.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HandoffDirectoryWriter {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern SafeFileHandle CreateFile(string name, uint access, uint sharing,
        IntPtr security, uint disposition, uint flags, IntPtr template);
}
'@
$handoffWriter=[HandoffDirectoryWriter]::CreateFile($Directory,0x40000000,7,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
try {
    if ($handoffWriter.IsInvalid) {throw 'Cannot establish the controlled directory-writer fixture.'}
    [Console]::Out.WriteLine('directoryWriterReady')
    [Console]::Out.Flush()
    [Console]::In.ReadLine() | Out-Null
} finally {$handoffWriter.Dispose()}
