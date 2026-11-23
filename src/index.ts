import { resolveAndroidAbiSuffix } from "./androidAbi.ts";
import { fileCacheFactory } from "./cache/fileCache.ts";
import {
	type Config,
	type ConfigInput as DiskCacheConfig,
	getConfig,
	packageName,
} from "./config/config";
import { withConfig } from "./config/withConfig.ts";
import { logger } from "./logger.ts";
import { getRemotePlugin } from "./remotePlugin/getRemotePlugin.ts";
import type { ResolvedProviderPlugin } from "./remotePlugin/resolveProviderPlugin.ts";
import { texts } from "./texts.ts";
import type {
	AndroidRunOptions,
	BuildCacheProviderPlugin,
	ResolveBuildCacheProps,
	UploadBuildCacheProps,
} from "./types/buildCacheProvider.ts";
import { tryCatch } from "./utils/tryCatch.ts";

/** See {@link resolveAndroidAbiSuffix}. iOS has none: Expo CLI caches iOS simulator builds alone. */
async function resolveAbi(args: ResolveBuildCacheProps): Promise<string | null> {
	if (args.platform !== "android") return "";
	const abi = await resolveAndroidAbiSuffix(args.runOptions as AndroidRunOptions);
	if (abi === null) logger.log(texts.abi.unknown);
	return abi;
}

/**
 * Loads the configured remote provider, if any. Any failure is logged and degrades to "no remote
 * plugin", so a broken remote never fails the local disk cache.
 */
async function withRemotePlugin<T>(
	args: ResolveBuildCacheProps,
	config: Config,
	use: (plugin: ResolvedProviderPlugin) => Promise<T>,
	onError: (error: unknown) => string,
): Promise<T | null> {
	if (!config.remotePlugin) return null;
	try {
		const plugin = await getRemotePlugin(args, { remotePlugin: config.remotePlugin });
		if (!plugin) return null;
		return await use(plugin);
	} catch (error) {
		logger.log(onError(error));
		return null;
	}
}

async function readFromDisk(args: ResolveBuildCacheProps, config: Config): Promise<string | null> {
	try {
		const abi = await resolveAbi(args);
		if (abi === null) return null;
		const fileCache = fileCacheFactory(args, config, abi);

		if (await fileCache.has()) {
			logger.log(texts.read.hit);
			await fileCache.cleanup();
			if (config.debug) await fileCache.printStats();
			return fileCache.getPath();
		}
		logger.log(texts.read.miss);
		// Remote providers key builds by fingerprint alone, so a single-ABI APK must never be
		// stored under that key or taken from it: its ABI cannot be checked after download.
		if (abi) return null;

		return await withRemotePlugin(
			args,
			config,
			async (plugin) => {
				const downloadPath = await plugin.resolveBuildCache(args, config.remoteOptions);
				if (!downloadPath) return null;
				// Copy to disk cache (to get properly cached)
				const { error } = await tryCatch(fileCache.write(downloadPath));
				return error ? null : fileCache.getPath();
			},
			texts.read.downloadError,
		);
	} catch (e) {
		logger.log(texts.read.error(e));
		return null;
	}
}

async function writeToDisk(args: UploadBuildCacheProps, config: Config): Promise<string | null> {
	let cachePath = "";
	try {
		const abi = await resolveAbi(args);
		if (abi === null) return null;
		const fileCache = fileCacheFactory(args, config, abi);
		cachePath = fileCache.getPath();

		if (await fileCache.has()) {
			logger.log(texts.write.alreadySaved);
			return cachePath;
		}

		await fileCache.cleanup();
		await fileCache.write(args.buildPath);

		logger.log(texts.write.savedToDisk(cachePath));
		await fileCache.printStats();

		if (!abi) {
			await withRemotePlugin(
				args,
				config,
				(plugin) => plugin.uploadBuildCache(args, config.remoteOptions),
				() => texts.write.remoteError,
			);
		}
		return cachePath;
	} catch (error) {
		logger.error(texts.write.error(cachePath, error));
		return null;
	}
}

const DiskBuildCacheProvider = {
	resolveBuildCache: withConfig(readFromDisk, getConfig),
	uploadBuildCache: withConfig(writeToDisk, getConfig),
} satisfies BuildCacheProviderPlugin<Partial<Config> | undefined>;

export default DiskBuildCacheProvider;

export type { DiskCacheConfig };

export type DiskCacheProvider = {
	plugin: typeof packageName;
	// DiskCacheConfig is already fully optional, so no Partial<> wrapper is needed here.
	options?: DiskCacheConfig;
};

export const buildDiskCacheProvider = (options?: DiskCacheConfig): DiskCacheProvider => ({
	plugin: packageName,
	options,
});
