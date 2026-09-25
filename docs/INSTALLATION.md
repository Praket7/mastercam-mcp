# Install Mastercam MCP

## Pick a setup

| Setup | What it needs | What it can do |
| --- | --- | --- |
| Portable | Node.js 22 or newer | Use sample data or review files you provide |
| Mastercam Stage A | Windows, licensed Mastercam, matching local NET Hook files | Report the installed Mastercam environment |
| Mastercam 2027 Stage B | Stage A items plus a supervised acceptance run | Read a limited operation snapshot |

The npm registry currently serves version 0.2.0 as `latest`. Version 0.3.0 is not on npm. Use a source checkout to try this branch. Do not copy an old `npx ...@latest` command from an earlier guide.

## Portable setup

Install Node.js 22 or newer. Open a terminal in the project folder. Run:

```text
pnpm install
pnpm run build
pnpm test
```

To start the fixture server on Windows PowerShell, run:

```powershell
$env:MASTERCAM_MCP_BACKEND = "mock"
node dist/cli.js serve
```

On macOS or Linux, run:

```sh
MASTERCAM_MCP_BACKEND=mock node dist/cli.js serve
```

The fixture uses sample data. It never connects to a machine.

## Windows Mastercam setup

Live access needs a licensed Mastercam installation, the matching local NET Hook files, and the .NET SDK supported by that release. Mastercam must be running before the MCP server connects.

Run the installer from PowerShell. Administrator approval is needed to copy files into the protected Mastercam folder.

```powershell
.\install.ps1 -ListInstallations
.\install.ps1 -MastercamRoot "C:\Program Files\Mastercam 2026" -ConfigureClients
```

The add in must match the installed Mastercam release. The package does not include Mastercam's private SDK files. The installer uses the files already installed on your workstation.

Start the server in read only mode. Check the connection before trying any write workflow.

```powershell
$env:MASTERCAM_MCP_PROFILE = "read"
node dist/cli.js doctor
node dist/cli.js acceptance --live
```

## Mastercam 2027 read candidate

Stage B is off by default. Set its switch before starting Mastercam. The add in reads this value when the application starts.

```powershell
$env:MASTERCAM_MCP_ENABLE_STAGE_B_READS = "1"
```

Launch Mastercam from that PowerShell session. Load the add in. Then run `node dist/cli.js acceptance --live` in another terminal.

`stageBContextReady` means the supported operation snapshot passed its checks. `liveReadReady` means all required read checks passed. Neither status proves machine simulation or write readiness.

## Write protection

The server starts with writes locked. A write profile alone does not unlock them. Both settings below are needed for the narrow preview and approval workflow.

```powershell
$env:MASTERCAM_MCP_PROFILE = "write"
$env:MASTERCAM_MCP_HARD_READ_ONLY = "0"
```

The connected MCP client must show the proposed before and after values to an operator. It must support MCP approval input. If the client cannot collect a clear approval, the server refuses the change. The server checks the part again before applying it.

Keep writes disabled until the matching Mastercam release passes live acceptance on a disposable test part. Posting, machine control, program transfer, and cycle start are not available.
