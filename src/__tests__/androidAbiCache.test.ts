import { describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import DiskBuildCacheProvider from "../index.ts";
import { texts } from "../texts.ts";
import type { ResolveBuildCacheProps } from "../types/buildCacheProvider.ts";
import { mockAppBuild } from "./mockAppBuild.ts";
import { defaultStubDevices, stubAdbDevices } from "./stubAdb.ts";
import { mockLogger } from "./test-setup.ts";
import { withProject } from "./withProject.ts";

const arm64Emulator = defaultStubDevices;
// A 32-bit userland Android TV box, which refuses arm64 APKs with INSTALL_FAILED_NO_MATCHING_ABIS.
const armv7TvBox = { "192.0.2.10:5555": "armeabi-v7a,armeabi" };

const config = { cacheDir: path.join(os.tmpdir(), "disk-cache-abi-test") };

const debugBuild = (variant = "debug"): ResolveBuildCacheProps => ({
	platform: "android",
	projectRoot: process.cwd(),
	runOptions: { variant },
	fingerprintHash: crypto.randomUUID(),
});

const upload = async (props: ResolveBuildCacheProps, cfg = config) =>
	DiskBuildCacheProvider.uploadBuildCache(
		{ ...props, buildPath: await mockAppBuild(props.fingerprintHash) },
		cfg,
	);

describe("Android ABI cache keys", () => {
	it.each(["debug", "freeDebug"])(
		"never serves a %s APK built for one ABI to a device of another",
		async (variant) => {
			const props = debugBuild(variant);

			stubAdbDevices(arm64Emulator);
			const saved = await upload(props);
			expect(saved).toEndWith(`fingerprint.${props.fingerprintHash}.arm64-v8a.apk`);

			stubAdbDevices(armv7TvBox);
			expect(await DiskBuildCacheProvider.resolveBuildCache(props, config)).toBeNull();
			expect(mockLogger.log).toHaveBeenLastCalledWith(texts.read.miss);

			stubAdbDevices(arm64Emulator);
			expect(await DiskBuildCacheProvider.resolveBuildCache(props, config)).toBe(saved);
		},
	);

	it("keeps one entry per ABI for the same fingerprint", async () => {
		const props = debugBuild();

		stubAdbDevices(arm64Emulator);
		const arm64 = await upload(props);
		stubAdbDevices(armv7TvBox);
		const armv7 = await upload(props);

		expect(armv7).toEndWith(`fingerprint.${props.fingerprintHash}.armeabi-v7a.apk`);
		expect(armv7).not.toBe(arm64);
	});

	it("keeps the plain name for builds that carry every ABI", async () => {
		const props = { ...debugBuild(), runOptions: { variant: "debug", allArch: true } };

		stubAdbDevices(armv7TvBox);
		const saved = await upload(props);
		expect(saved).toEndWith(`fingerprint.${props.fingerprintHash}.apk`);

		stubAdbDevices(arm64Emulator);
		expect(await DiskBuildCacheProvider.resolveBuildCache(props, config)).toBe(saved);
	});

	it.each([
		["no device is attached", {}],
		["attached devices differ in ABI", { ...arm64Emulator, ...armv7TvBox }],
	])("skips the cache when %s", async (_, devices) => {
		const props = debugBuild();
		stubAdbDevices(devices);

		expect(await upload(props)).toBeNull();
		expect(await DiskBuildCacheProvider.resolveBuildCache(props, config)).toBeNull();
		expect(mockLogger.log).toHaveBeenLastCalledWith(texts.abi.unknown);
	});

	describe("remote plugin", () => {
		const remoteCalls: string[] = [];
		(globalThis as { remoteCalls?: string[] }).remoteCalls = remoteCalls;

		const providerSource = `module.exports = {
			resolveBuildCache: async () => { globalThis.remoteCalls.push("resolve"); return null; },
			uploadBuildCache: async () => { globalThis.remoteCalls.push("upload"); return null; },
		};`;
		const remoteConfig = { ...config, remotePlugin: "./provider.js" };

		// Remote providers key by fingerprint alone, so a single-ABI APK could reach any device.
		it.each([
			["is skipped for single-ABI builds", "debug", []],
			["is skipped for flavored single-ABI builds", "freeDebug", []],
			["still runs for builds that carry every ABI", "release", ["resolve", "upload"]],
		])("%s", async (_, variant, expected) => {
			await withProject({ "provider.js": providerSource }, async (projectRoot) => {
				const props = { ...debugBuild(), projectRoot, runOptions: { variant } };
				remoteCalls.length = 0;

				await DiskBuildCacheProvider.resolveBuildCache(props, remoteConfig);
				await upload(props, remoteConfig);
				expect(remoteCalls).toEqual(expected);
			});
		});
	});
});
