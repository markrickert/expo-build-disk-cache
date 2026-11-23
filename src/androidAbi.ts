import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AndroidRunOptions } from "./types/buildCacheProvider.ts";
import { dedupeArray } from "./utils/dedupeArray.ts";
import { tryCatch } from "./utils/tryCatch.ts";

/*
`expo run:android` compiles a debug build for the connected device's ABI alone: Expo CLI passes
`-PreactNativeArchitectures=<abi>` to Gradle. The fingerprint does not change with the ABI, so an
arm64 APK cached from an emulator would be served to a 32-bit Android TV box, which refuses it with
INSTALL_FAILED_NO_MATCHING_ABIS. These rules add the ABI to the cache file name whenever the build
is restricted to one.
*/

// Mirrors VALID_ARCHITECTURES and getConnectedDeviceABI in @expo/cli's
// `run/android/resolveGradlePropsAsync`, so the key names what Gradle built.
const BUILDABLE_ABIS = ["armeabi-v7a", "arm64-v8a", "x86", "x86_64"];

// adb starts its server on first use, which can take a few seconds. A hung adb must not hang
// `expo run`, so the cache is skipped when an adb call runs past this limit.
const ADB_TIMEOUT_MS = 15_000;

type RunAdb = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

// Expo also consults ANDROID_SDK_ROOT and the platform's default SDK install location, so an
// ANDROID_HOME-only lookup misses adb on machines configured either of those ways. A set but
// missing env path is still used: adb fails to spawn and the cache skips like any adb error.
// https://github.com/expo/expo/blob/main/packages/@expo/cli/src/start/platforms/android/AndroidSdk.ts
const DEFAULT_SDK_LOCATIONS: Record<string, string[]> = {
	darwin: [path.join(homedir(), "Library", "Android", "sdk")],
	linux: [path.join(homedir(), "Android", "Sdk"), path.join(homedir(), "Android", "sdk")],
	win32: [path.join(homedir(), "AppData", "Local", "Android", "Sdk")],
};

const resolveAdbPath = (): string => {
	const sdkRoot =
		process.env["ANDROID_HOME"] ||
		process.env["ANDROID_SDK_ROOT"] ||
		DEFAULT_SDK_LOCATIONS[process.platform]?.find(existsSync);
	return sdkRoot ? path.join(sdkRoot, "platform-tools", "adb") : "adb";
};

const runAdb: RunAdb = async (args) => {
	const { stdout } = await execFileAsync(resolveAdbPath(), args, { timeout: ADB_TIMEOUT_MS });
	return stdout;
};

/** The ABI Expo builds for a device, from its `ro.product.cpu.abilist`. */
const primaryAbi = (abiList: string): string | undefined =>
	abiList
		.trim()
		.split(",")
		.find((abi) => BUILDABLE_ABIS.includes(abi));

/**
 * Serials of the devices `adb devices` reports ready, emulators included. Matching on the state
 * column alone also skips the header and the lines adb prints while it starts its server.
 */
const readySerials = (adbDevicesOutput: string): string[] =>
	adbDevicesOutput
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([serial, state]) => serial && state === "device")
		.map(([serial]) => serial as string);

// Expo takes the build type from the last camel-case segment, or the last two when that is
// `Optimized`, so flavored debug builds still target one ABI. Release variants and `--all-arch`
// builds carry every ABI, so any device can install them.
// https://github.com/expo/expo/blob/main/packages/@expo/cli/src/run/android/resolveGradlePropsAsync.ts
const isSingleAbiBuild = ({ variant = "debug", allArch }: AndroidRunOptions): boolean =>
	!allArch && /(?:^d|D)ebug(?:Optimized)?$/.test(variant);

/** Mirrors getDeviceABIsAsync in @expo/cli: older devices only set `ro.product.cpu.abi`. */
const deviceAbi = async (serial: string, adb: RunAdb): Promise<string | undefined> => {
	const getprop = (prop: string) => adb(["-s", serial, "shell", "getprop", prop]);
	const abiList = (await getprop("ro.product.cpu.abilist")).trim();
	return primaryAbi(abiList || (await getprop("ro.product.cpu.abi")));
};

/** The ABI of each ready device. */
const connectedAbis = async (adb: RunAdb): Promise<(string | undefined)[]> => {
	const serials = readySerials(await adb(["devices"]));
	return Promise.all(serials.map((serial) => deviceAbi(serial, adb)));
};

/**
 * The cache key suffix for an Android build: "" when the APK carries every ABI, the ABI when it
 * carries one, and null when the cache must be skipped for the run, both lookup and save. Null
 * covers no device, devices of different ABIs, and any adb failure, because a wrong guess installs
 * an APK the device rejects and a fresh build never replaces it.
 */
export async function resolveAndroidAbiSuffix(
	runOptions: AndroidRunOptions,
	adb: RunAdb = runAdb,
): Promise<string | null> {
	if (!isSingleAbiBuild(runOptions)) return "";
	const { data } = await tryCatch(connectedAbis(adb));
	const abis = dedupeArray(data ?? []);
	return abis.length === 1 ? (abis[0] ?? null) : null;
}
