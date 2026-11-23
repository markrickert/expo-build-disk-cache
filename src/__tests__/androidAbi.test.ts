import { describe, expect, it } from "bun:test";
import { resolveAndroidAbiSuffix } from "../androidAbi.ts";
import { stubAndroidHome } from "./stubAdb.ts";

describe("resolveAndroidAbiSuffix", () => {
	// Answers adb like real devices do: `adb devices` lists the serials as ready, and
	// `adb -s <serial> shell getprop <prop>` reads that device's props.
	const fakeAdb = (devices: Record<string, Record<string, string>>) => async (args: string[]) => {
		if (args[0] === "devices") {
			const serials = Object.keys(devices).map((serial) => `${serial}\tdevice`);
			return ["List of devices attached", ...serials].join("\n");
		}
		return devices[args[1] ?? ""]?.[args.at(-1) ?? ""] ?? "";
	};

	const failingAdb = async (): Promise<string> => {
		throw new Error("spawn adb ENOENT");
	};

	const arm64Emulator = {
		"emulator-5554": { "ro.product.cpu.abilist": "arm64-v8a,armeabi-v7a,armeabi\n" },
	};

	it.each(["debug", "freeDebug", "previewDebugOptimized", "debugOptimized"])(
		"keys a %s build by the device ABI",
		async (variant) => {
			expect(await resolveAndroidAbiSuffix({ variant }, fakeAdb(arm64Emulator))).toBe("arm64-v8a");
		},
	);

	it("does not run adb for builds that carry every ABI", async () => {
		expect(await resolveAndroidAbiSuffix({ variant: "release" }, failingAdb)).toBe("");
		expect(await resolveAndroidAbiSuffix({ variant: "freeRelease" }, failingAdb)).toBe("");
		expect(await resolveAndroidAbiSuffix({ allArch: true }, failingAdb)).toBe("");
	});

	it("falls back to ro.product.cpu.abi when the ABI list is empty", async () => {
		const adb = fakeAdb({ "emulator-5554": { "ro.product.cpu.abi": "x86_64\n" } });
		expect(await resolveAndroidAbiSuffix({}, adb)).toBe("x86_64");
	});

	// Expo builds for one of them, and the key cannot say which.
	it("skips the cache when the connected devices differ in ABI", async () => {
		const adb = fakeAdb({
			"emulator-5554": { "ro.product.cpu.abilist": "arm64-v8a\n" },
			"192.0.2.10:5555": { "ro.product.cpu.abilist": "armeabi-v7a\n" },
		});
		expect(await resolveAndroidAbiSuffix({}, adb)).toBeNull();
	});

	it("skips the cache with no device to read", async () => {
		expect(await resolveAndroidAbiSuffix({}, fakeAdb({}))).toBeNull();
	});

	it("skips the cache when adb fails", async () => {
		expect(await resolveAndroidAbiSuffix({}, failingAdb)).toBeNull();
	});

	// Expo also finds adb via ANDROID_SDK_ROOT. The global setup only sets ANDROID_HOME, and its
	// afterEach restores the stub's default arm64 device this test runs against.
	it("finds adb under ANDROID_SDK_ROOT when ANDROID_HOME is unset", async () => {
		const originalEnv = { ...process.env };
		delete process.env["ANDROID_HOME"];
		process.env["ANDROID_SDK_ROOT"] = stubAndroidHome;
		try {
			expect(await resolveAndroidAbiSuffix({})).toBe("arm64-v8a");
			// Expo treats an empty ANDROID_HOME as unset as well.
			process.env["ANDROID_HOME"] = "";
			expect(await resolveAndroidAbiSuffix({})).toBe("arm64-v8a");
		} finally {
			process.env = originalEnv;
		}
	});
});
