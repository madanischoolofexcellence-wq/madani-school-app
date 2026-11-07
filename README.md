# Madani School of Excellence — Android App

Public installer for the Madani School management app. The app opens the school's
live system inside an app icon.

## Install on Windows PC
Open the latest release, download **MadaniSchool-Setup.exe**, and run it. It adds a
"Madani School" shortcut to the desktop and Start menu. Install it once — never reinstall:
changes to the school system appear immediately, and new versions of the app download in the
background and install themselves (silently, at a quiet moment or when the app is closed).
Keep it open (logged in) on a PC at school that is on the same network as the fingerprint
device — it reads the device every 5 minutes and sends the attendance to the online system.
It starts by itself when Windows starts.

**Without internet** the app keeps working: it runs the school system on the PC from a copy of the
data and sends the work to the online system when the internet is back. For this an admin must have
been signed in on the PC while the internet was on (menu **Offline → Offline status** shows whether the
PC is ready). Code: `desktop/offline.js`; details in `OFFLINE.md` of the school system's repository.

## Install on Android
Open the latest release, download **MadaniSchool.apk**, and install it
(allow "install from unknown sources" when asked).

Releases: https://github.com/madanischoolofexcellence-wq/madani-school-app/releases/latest

The source code of the management system itself is kept in a separate private repository.
