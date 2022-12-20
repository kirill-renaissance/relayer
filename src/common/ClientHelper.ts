import winston from "winston";
import { getProvider, getDeployedContract, getDeploymentBlockNumber, Wallet, Contract } from "../utils";
import { HubPoolClient, MultiCallerClient, AcrossConfigStoreClient, SpokePoolClient } from "../clients";
import { CommonConfig } from "./Config";
import { createClient } from "redis4";
import { SpokePoolClientsByChain } from "../interfaces";
import { utils } from "@across-protocol/sdk-v2"

export interface Clients {
  hubPoolClient: HubPoolClient;
  configStoreClient: AcrossConfigStoreClient;
  multiCallerClient: MultiCallerClient;
  hubSigner?: Wallet;
}

export function getSpokePoolSigners(baseSigner: Wallet, config: CommonConfig): { [chainId: number]: Wallet } {
  return Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      return [chainId, baseSigner.connect(getProvider(chainId))];
    })
  );
}

export async function constructSpokePoolClientsWithLookback(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  baseSigner: Wallet,
  initialLookBackOverride = 0
): Promise<SpokePoolClientsByChain> {
  // Set up Spoke signers and connect them to spoke pool contract objects:
  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);
  const spokePools = config.spokePoolChains.map((chainId) => {
    return { chainId, contract: getDeployedContract("SpokePool", chainId, spokePoolSigners[chainId]) };
  });

  // If initial lookback override is non-zero, then look up the l2 block number at that time, otherwise
  // use latest L2 block.
  const _fromBlocks = await Promise.all(
    initialLookBackOverride > 0 ?
        spokePools.map((obj: { chainId: number; contract: Contract }) => utils.findBlockAtOrOlder(obj.contract.provider, initialLookBackOverride))
      :
        spokePools.map((obj: { contract: Contract }) => obj.contract.provider.getBlockNumber())
  );
  const fromBlocks = Object.fromEntries(spokePools.map((obj: { chainId: number }, i: number) => { return [obj.chainId, _fromBlocks[i]] }))

  return getSpokePoolClientsForContract(logger, configStoreClient, config, spokePools, fromBlocks);
}

function getSpokePoolClientsForContract(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  spokePools: { chainId: number; contract: Contract }[],
  fromBlocks: { [chainId: number]: number },
  toBlocks: { [chainId: number]: number } = {}
): SpokePoolClientsByChain {
  const spokePoolClients: SpokePoolClientsByChain = {};
  spokePools.forEach(({ chainId, contract }) => {
    const spokePoolDeploymentBlock = getDeploymentBlockNumber("SpokePool", chainId);
    const spokePoolClientSearchSettings = {
      fromBlock: fromBlocks[chainId]
        ? Math.max(fromBlocks[chainId], spokePoolDeploymentBlock)
        : spokePoolDeploymentBlock,
      toBlock: toBlocks[chainId] ? toBlocks[chainId] : undefined,
      maxBlockLookBack: config.maxBlockLookBack[chainId],
    };
    spokePoolClients[chainId] = new SpokePoolClient(
      logger,
      contract,
      configStoreClient,
      chainId,
      spokePoolClientSearchSettings,
      spokePoolDeploymentBlock
    );
  });

  return spokePoolClients;
}

export async function updateSpokePoolClients(
  spokePoolClients: { [chainId: number]: SpokePoolClient },
  eventsToQuery?: string[]
): Promise<void> {
  await Promise.all(Object.values(spokePoolClients).map((client: SpokePoolClient) => client.update(eventsToQuery)));
}

export async function constructClients(
  logger: winston.Logger,
  config: CommonConfig,
  baseSigner: Wallet
): Promise<Clients> {
  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId, logger));

  // Create contract instances for each chain for each required contract.
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);

  const configStore = getDeployedContract("AcrossConfigStore", config.hubPoolChainId, hubSigner);

  const hubPoolClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("HubPool", config.hubPoolChainId)),
    toBlock: undefined, // Important that we set this to `undefined` to always look up latest HubPool events such as
    // ProposeRootBundle in order to match a bundle block evaluation block range with a pending root bundle.
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };
  const hubPoolClient = new HubPoolClient(logger, hubPool, hubPoolClientSearchSettings);

  const rateModelClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("AcrossConfigStore", config.hubPoolChainId)),
    toBlock: undefined,
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };

  let redisClient: ReturnType<typeof createClient> | undefined;
  if (config.redisUrl) {
    redisClient = createClient({
      url: config.redisUrl,
    });
    await redisClient.connect();
    logger.debug({
      at: "Dataworker#ClientHelper",
      message: `Connected to redis server at ${config.redisUrl} successfully!`,
      dbSize: await redisClient.dbSize(),
    });
  }

  const configStoreClient = new AcrossConfigStoreClient(
    logger,
    configStore,
    hubPoolClient,
    rateModelClientSearchSettings,
    redisClient
  );

  const multiCallerClient = new MultiCallerClient(logger);

  return { hubPoolClient, configStoreClient, multiCallerClient, hubSigner };
}

export async function updateClients(clients: Clients) {
  await Promise.all([clients.hubPoolClient.update(), clients.configStoreClient.update()]);
}
