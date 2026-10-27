import { Buffer } from "node:buffer";

/** cmd.exe caps a command line at 8191 characters; the encoded script must leave room for the argv. */
export const POWERSHELL_ENCODED_MAX = 7_600;

export function powershellArgv(script: string): string[] {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  if (encoded.length > POWERSHELL_ENCODED_MAX) throw new Error("Remote PowerShell command exceeds the cmd.exe-compatible command-line budget");
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

/**
 * Starts one native process with CRT-quoted arguments and inherited standard handles, so stdin
 * bytes reach it untouched and its exit status becomes the host's. The process joins a job that
 * is killed when the PowerShell host's last handle closes, so a dropped SSH channel cannot leave
 * the remote ocx running; silent breakaway leaves any runtime that ocx itself starts alone.
 */
const NATIVE_PROCESS = String.raw`
$ErrorActionPreference='Stop'
function Quote-Native([string]$v){'"'+[regex]::Replace([regex]::Replace($v,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'}
function New-KillJob{try{Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OcxJob{[DllImport("kernel32.dll")]public static extern IntPtr CreateJobObject(IntPtr a,string n);[DllImport("kernel32.dll")]public static extern bool SetInformationJobObject(IntPtr j,int c,byte[] i,int l);[DllImport("kernel32.dll")]public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);}'
$j=[OcxJob]::CreateJobObject([IntPtr]::Zero,$null);$i=New-Object byte[] 144;$i[17]=0x30
if($j -ne [IntPtr]::Zero -and [OcxJob]::SetInformationJobObject($j,9,$i,144)){return $j}}catch{};[IntPtr]::Zero}
function Invoke-Native([string]$exe,[string[]]$arguments){$job=New-KillJob
$s=New-Object Diagnostics.ProcessStartInfo;$s.FileName=$exe;$s.UseShellExecute=$false
$s.Arguments=(($arguments|ForEach-Object{Quote-Native $_}) -join ' ')
$p=[Diagnostics.Process]::Start($s)
if($job -ne [IntPtr]::Zero){[void][OcxJob]::AssignProcessToJobObject($job,$p.Handle)}
$p.WaitForExit();exit $p.ExitCode}
function Read-Data([string]$b){[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))|ConvertFrom-Json}
`;

function encodedData(value: { executable?: string; args: readonly string[] }): string {
  if ([value.executable ?? "", ...value.args].some(item => item.includes("\0"))) throw new Error("Remote argument contains NUL");
  // An object wrapper: Windows PowerShell 5.1 emits a top-level JSON array unenumerated.
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function windowsNativeArgv(executable: string, args: readonly string[]): string[] {
  const data = encodedData({ executable, args });
  return powershellArgv(NATIVE_PROCESS + `$d=Read-Data '${data}'
Invoke-Native $d.executable @($d.args)
`);
}

/**
 * Desktop first, then the GOAT-managed current junction, then legacy and PATH candidates. Each
 * must answer --version within ten seconds; only the selected one runs the real command.
 */
export function windowsOcxArgv(args: readonly string[]): string[] {
  const data = encodedData({ args });
  return powershellArgv(NATIVE_PROCESS + `$d=Read-Data '${data}'
$u=$env:USERPROFILE;$c=@((Join-Path $u '.opencodex-desktop/bin/ocx.exe'),(Join-Path $u '.local/share/goat/opencodex/current/ocx.exe'),(Join-Path $u '.local/bin/ocx.exe'))
if($env:LOCALAPPDATA){$c+=Join-Path $env:LOCALAPPDATA 'Programs/OpenCodex/ocx.exe'}
if($env:ProgramFiles){$c+=Join-Path $env:ProgramFiles 'OpenCodex/ocx.exe'}
$c+=@(Get-Command ocx.exe -CommandType Application -ErrorAction SilentlyContinue|ForEach-Object{$_.Source})
foreach($x in ($c|Select-Object -Unique)){if(-not [IO.File]::Exists($x)){continue}
$s=New-Object Diagnostics.ProcessStartInfo;$s.FileName=$x;$s.Arguments='--version';$s.UseShellExecute=$false
$s.RedirectStandardInput=$true;$s.RedirectStandardOutput=$true;$s.RedirectStandardError=$true
try{$q=[Diagnostics.Process]::Start($s);$q.StandardInput.Close();[void]$q.StandardOutput.ReadToEndAsync();[void]$q.StandardError.ReadToEndAsync()
if(-not $q.WaitForExit(10000)){$q.Kill();$q.WaitForExit();continue}
if($q.ExitCode -ne 0){continue}}catch{continue}
Invoke-Native $x @($d.args)}
[Console]::Error.WriteLine('No runnable standalone ocx.exe found; install the Windows standalone archive in a supported location.')
exit 127
`);
}

/** Credential-free loopback probe of the Child; no proxy, no redirect, bounded body and deadline. */
export function windowsChildHttpArgv(port: number, path: "healthz" | "v1/catalog", timeoutMs: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid Child port");
  if (path !== "healthz" && path !== "v1/catalog") throw new Error("invalid Child HTTP path");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid Child HTTP deadline");
  const budget = Math.max(1, Math.min(15_000, Math.ceil(timeoutMs)));
  return powershellArgv(`$ErrorActionPreference='Stop';$r=$null
try{$w=[Diagnostics.Stopwatch]::StartNew()
$q=[Net.HttpWebRequest]::Create('http://127.0.0.1:${port}/${path}');$q.Proxy=$null;$q.AllowAutoRedirect=$false;$q.Timeout=${budget};$q.ReadWriteTimeout=${budget}
$r=$q.GetResponse();if([int]$r.StatusCode -ne 200){throw 'status'}
$t=$r.GetResponseStream();$o=New-Object IO.MemoryStream;$b=New-Object byte[] 8192
while($true){$left=${budget}-[int]$w.ElapsedMilliseconds;if($left -le 0){throw 'deadline'}
$t.ReadTimeout=$left;$n=$t.Read($b,0,$b.Length);if($n -eq 0){break}
if($o.Length+$n -gt 4194304){throw 'size'};$o.Write($b,0,$n)}
$e=New-Object Text.UTF8Encoding($false,$true);[Console]::OutputEncoding=$e
[Console]::Write($e.GetString($o.ToArray())+[char]10+'200');exit 0
}catch{[Console]::Error.WriteLine('Child loopback HTTP probe failed.');exit 1}finally{if($r){$r.Dispose()}}
`);
}
