import { Buffer } from "node:buffer";

/**
 * cmd.exe, Windows OpenSSH's default shell, caps its command line at 8191 characters. The encoded
 * script leaves room for the fixed powershell.exe prefix and cmd.exe's own wrapper.
 */
export const POWERSHELL_ENCODED_MAX = 8_000;

export function powershellArgv(script: string): string[] {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  if (encoded.length > POWERSHELL_ENCODED_MAX) throw new Error("Remote PowerShell command exceeds the cmd.exe-compatible command-line budget");
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

/** Exit status when the remote ocx cannot be contained; nothing ran. */
export const WINDOWS_CONTAINMENT_EXIT = 126;

/**
 * OcxJob, compiled with Add-Type, contains the remote ocx. Run creates it suspended, assigns it to
 * a Job with kill-on-close and silent breakaway, and only then resumes it, so it never runs outside
 * the Job: when the SSH server ends a dropped channel by terminating this PowerShell host, the
 * Job's last handle closes and ocx.exe dies with it, while a runtime ocx starts on its own breaks
 * away and survives. Standard handles are inherited, so stdin bytes reach ocx untouched, and its
 * exit status becomes the host's. If Add-Type, the Job, the suspended start, the assignment or the
 * resume fails, the child is killed before it runs and the host exits 126; there is no uncontained
 * fallback. Ok is the bounded --version probe for discovery. Layouts are x64: STARTUPINFOW is 104
 * bytes and LimitFlags sits at byte 16 of the 144-byte JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
 * Warnings fail Add-Type in Windows PowerShell, so this source must compile without any.
 */
const OCX_JOB = "using System;using System.Text;using System.Diagnostics;using System.Runtime.InteropServices;public static class OcxJob{[DllImport(\"kernel32\")]static extern IntPtr CreateJobObjectW(IntPtr a,IntPtr n);[DllImport(\"kernel32\")]static extern bool SetInformationJobObject(IntPtr j,int c,byte[] i,int l);[DllImport(\"kernel32\",CharSet=CharSet.Unicode)]static extern bool CreateProcessW(string a,StringBuilder c,IntPtr p,IntPtr t,bool h,int f,IntPtr e,string d,long[] s,long[] i);[DllImport(\"kernel32\")]static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);[DllImport(\"kernel32\")]static extern int ResumeThread(IntPtr t);static IntPtr Z=IntPtr.Zero;static void F(bool k){if(!k)throw new Exception();}public static bool Ok(string x){try{var q=Process.Start(new ProcessStartInfo(x,\"--version\"){UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true});q.StandardInput.Close();q.StandardOutput.ReadToEndAsync();q.StandardError.ReadToEndAsync();if(q.WaitForExit(10000))return q.ExitCode==0;q.Kill();}catch{}return false;}public static int Run(string x,string c){var j=CreateJobObjectW(Z,Z);var l=new byte[144];l[17]=48;F(j!=Z&&SetInformationJobObject(j,9,l,144));var s=new long[13];s[0]=104;var i=new long[3];F(CreateProcessW(x,new StringBuilder(c),Z,Z,true,4,Z,null,s,i));var p=Process.GetProcessById((int)i[2]);F(p.Handle!=Z);if(!AssignProcessToJobObject(j,new IntPtr(i[0]))||ResumeThread(new IntPtr(i[1]))<0){p.Kill();F(false);}p.WaitForExit();return p.ExitCode;}}";

const NATIVE_PROCESS = String.raw`$ErrorActionPreference='Stop'
function Fail{[Console]::Error.WriteLine('Refusing to run ocx.exe outside a kill-on-close job.');exit 126}
try{Add-Type '` + OCX_JOB + String.raw`'}catch{Fail}
function Quote-Native([string]$v){'"'+[regex]::Replace([regex]::Replace($v,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'}
function Invoke-Native([string]$e,[string[]]$a){try{$c=[OcxJob]::Run($e,((@($e)+$a|%{Quote-Native $_}) -join ' '))}catch{Fail};exit $c}
`;

/** The one line that carries the argument object; builder and decoder share these constants. */
const DATA_OPEN = "$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('";
const DATA_CLOSE = "'))|ConvertFrom-Json\n";

function dataLine(value: { executable?: string; args: readonly string[] }): string {
  if ([value.executable ?? "", ...value.args].some(item => item.includes("\0"))) throw new Error("Remote argument contains NUL");
  // An object wrapper: Windows PowerShell 5.1 emits a top-level JSON array unenumerated.
  return DATA_OPEN + Buffer.from(JSON.stringify(value), "utf8").toString("base64") + DATA_CLOSE;
}

/**
 * The argument object a script from this module carries, read back from its decoded script text;
 * undefined for any other script. Test fixtures decode with this, never with their own pattern.
 */
export function windowsScriptData(script: string): { executable?: string; args: string[] } | undefined {
  const start = script.indexOf(DATA_OPEN);
  const end = start < 0 ? -1 : script.indexOf(DATA_CLOSE, start + DATA_OPEN.length);
  if (end < 0) return undefined;
  const value: unknown = JSON.parse(Buffer.from(script.slice(start + DATA_OPEN.length, end), "base64").toString("utf8"));
  if (!value || typeof value !== "object" || !Array.isArray((value as { args?: unknown }).args)) return undefined;
  return value as { executable?: string; args: string[] };
}

export function windowsNativeArgv(executable: string, args: readonly string[]): string[] {
  return powershellArgv(NATIVE_PROCESS + dataLine({ executable, args }) + "Invoke-Native $d.executable @($d.args)\n");
}

/**
 * Desktop first, then the GOAT-managed current junction, then legacy and PATH candidates. Each
 * must answer --version within ten seconds; only the selected one runs the real command.
 */
export function windowsOcxArgv(args: readonly string[]): string[] {
  return powershellArgv(NATIVE_PROCESS + dataLine({ args }) + String.raw`$u=$env:USERPROFILE;$c=@("$u\.opencodex-desktop\bin\ocx.exe","$u\.local\share\goat\opencodex\current\ocx.exe","$u\.local\bin\ocx.exe")
if($env:LOCALAPPDATA){$c+="$env:LOCALAPPDATA\Programs\OpenCodex\ocx.exe"}
if($env:ProgramFiles){$c+="$env:ProgramFiles\OpenCodex\ocx.exe"}
$c+=@((Get-Command ocx.exe -Type Application -EA 0).Source)
foreach($x in ($c|select -Unique)){if([IO.File]::Exists($x)-and[OcxJob]::Ok($x)){Invoke-Native $x @($d.args)}}
[Console]::Error.WriteLine('No runnable ocx.exe found; install the Windows standalone archive.');exit 127
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
