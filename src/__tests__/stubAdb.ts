import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A fake Android SDK whose `platform-tools/adb` answers `adb devices` and
 * `adb -s <serial> shell getprop <prop>` from files in its own directory. Pointing `ANDROID_HOME`
 * at it keeps every test independent of the adb and the devices of the machine running them.
 */
const androidHome = fs.mkdtempSync(path.join(os.tmpdir(), "expo-disk-cache-adb-"));
const platformTools = path.join(androidHome, "platform-tools");

const script = `#!/bin/sh
dir=$(dirname "$0")
if [ "$1" = "devices" ]; then
	echo "List of devices attached"
	cat "$dir/devices" 2>/dev/null
	exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ]; then
	cat "$dir/$2.$5" 2>/dev/null
	exit 0
fi
exit 1
`;

fs.mkdirSync(platformTools, { recursive: true });
fs.writeFileSync(path.join(platformTools, "adb"), script, { mode: 0o755 });

export const stubAndroidHome = androidHome;

/** One ready arm64 emulator, the setup most of the suite runs against. */
export const defaultStubDevices = { "emulator-5554": "arm64-v8a,armeabi-v7a,armeabi" };

/** Replaces the attached devices with ready devices, keyed by serial, of the given ABI lists. */
export const stubAdbDevices = (devices: Record<string, string>) => {
	for (const file of fs.readdirSync(platformTools)) {
		if (file !== "adb") fs.rmSync(path.join(platformTools, file));
	}
	const lines = Object.keys(devices).map((serial) => `${serial}\tdevice\n`);
	fs.writeFileSync(path.join(platformTools, "devices"), lines.join(""));
	for (const [serial, abiList] of Object.entries(devices)) {
		fs.writeFileSync(path.join(platformTools, `${serial}.ro.product.cpu.abilist`), `${abiList}\n`);
	}
};
