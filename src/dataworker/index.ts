import {
  processEndPollingLoop,
  winston,
  config,
  startupLogLevel,
  Wallet,
  getLatestInvalidBundleStartBlocks,
} from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  updateDataworkerClients,
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  spokePoolClientsToProviders,
} from "./DataworkerClientHelper";
import { BalanceAllocator } from "../clients/BalanceAllocator";
import { SpokePoolClientsByChain } from "../interfaces";
config();
let logger: winston.Logger;

export async function createDataworker(_logger: winston.Logger, baseSigner: Wallet) {
  const config = new DataworkerConfig(process.env);
  const clients = await constructDataworkerClients(_logger, config, baseSigner);

  const dataworker = new Dataworker(
    _logger,
    clients,
    Constants.CHAIN_ID_LIST_INDICES,
    config.maxRelayerRepaymentLeafSizeOverride,
    config.maxPoolRebalanceLeafSizeOverride,
    config.tokenTransferThresholdOverride,
    config.blockRangeEndBlockBuffer,
    config.spokeRootsLookbackCount,
    config.bufferToPropose
  );

  return {
    config,
    clients,
    dataworker,
  };
}
export async function runDataworker(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;
  const { clients, config, dataworker } = await createDataworker(logger, baseSigner);
  try {
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    for (;;) {
      const loopStart = Date.now();
      await updateDataworkerClients(clients);

      // Grab end blocks for latest fully executed bundle. We can use this block to optimize the dataworker event
      // search by loading partially from the cache and only saving into the cache all blocks older than or equal
      // to the bundle end blocks for the chains. This will let the dataworker's proposal and validation logic
      // to continue to fetch fresh events while allowing the leaf execution methods to use cached logic and overall
      // reduce the number of web3 requests sent.
      const latestFullyExecutedBundleEndBlocks = clients.hubPoolClient.getLatestFullyExecutedRootBundle(
        clients.hubPoolClient.latestBlockNumber
      ).bundleEvaluationBlockNumbers;
      const bundleEndBlockMapping = Object.fromEntries(
        dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, index) => {
          return [chainId, latestFullyExecutedBundleEndBlocks[index].toNumber()];
        })
      );

      // Construct spoke pool clients.
      let spokePoolClients: SpokePoolClientsByChain;

      // Record the latest blocks for each spoke client that we can use to construct root bundles. This is dependent
      // on the fills for the client having matching deposit events on a different client. If a fill cannot be matched
      // with a deposit then we can't construct a root bundle for it.
      let latestInvalidBundleStartBlocks: { [chainId: number]: number } = {};

      // We'll construct and update the spoke pool clients with a short lookback with an eye to
      // reducing compute time. With the data we load, we need to check if there are any fills that cannot be
      // matched with a deposit in the events loaded by the clients. This would make constructing accurate root
      // bundles potentially impossible. So, we should save the last block for each chain with fills that we can
      // construct or validate root bundles for.

      // In summary:
      // 1. We generate the spoke client event search windows based on a start bundle's bundle block end numbers and
      //    how many bundles we want to look back from the start bundle blocks.
      // 2. For example, if the start bundle is 100 and the lookback is 16, then we will set the spoke client event
      //    search window's toBlocks equal to the 100th bundle's block evaluation numbers and the fromBlocks equal
      //    to the 84th bundle's block evaluation numbers.
      // 3. Once we do all the querying, we figure out the earliest block that we’re able to validate per chain.
      //    This logic can be found in `getLatestInvalidBundleStartBlocks()`
      // 4. If the earliest block we can validate is later than the latest fully executed bundle's end blocks,
      //    then extend the SpokePoolClients' lookbacks and update again. Do this up to a specified # of retries.
      //    By dynamically increasing the range of Deposit events to at least cover the next/pending bundle's
      //    start blocks, we can reduce the error rate. This is because of how the disputer and proposer will handle
      //    the case where it can't validate a fill without loading an earlier block.
      // 5. If the bundle we’re trying to validate or propose requires an earlier block, then exit early and
      //    emit an alert. In the dispute flow, this alert should be ERROR level.
      const customConfig = { ...config };
      for (let i = 0; i <= config.dataworkerFastLookbackRetryCount; i++) {
        const { fromBundle, toBundle, fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(
          customConfig,
          clients,
          dataworker
        );

        logger.debug({
          at: "Dataworker#index",
          message:
            "Setting start blocks for SpokePoolClient equal to bundle evaluation end blocks from Nth latest valid root bundle",
          dataworkerFastStartBundle: customConfig.dataworkerFastStartBundle,
          dataworkerFastLookbackRetryCount: customConfig.dataworkerFastLookbackRetryCount,
          dataworkerFastLookbackRetryMultiplier: customConfig.dataworkerFastLookbackRetryMultiplier,
          retriesMade: i,
          dataworkerFastLookbackCount: customConfig.dataworkerFastLookbackCount,
          fromBlocks,
          toBlocks,
          fromBundleTxn: fromBundle?.transactionHash,
          toBundleTxn: toBundle?.transactionHash,
        });

        spokePoolClients = await constructSpokePoolClientsForFastDataworker(
          logger,
          clients.configStoreClient,
          customConfig,
          baseSigner,
          fromBlocks,
          toBlocks
        );
        latestInvalidBundleStartBlocks = getLatestInvalidBundleStartBlocks(spokePoolClients);

        // Increase SpokePoolClient event lookback if any of the invalid bundle start blocks are later
        // than one of the bundle end blocks in the latest executed bundle.
        if (
          Object.entries(latestInvalidBundleStartBlocks).some(([chainId, invalidBundleStartBlock]) => {
            return invalidBundleStartBlock > bundleEndBlockMapping[chainId];
          })
        ) {
          // Overwrite fast lookback count.
          customConfig.dataworkerFastLookbackCount *= config.dataworkerFastLookbackRetryMultiplier;

          // !!Note: This is a very inefficient algorithm as it requeries all events from the new fromBlocks to the
          // same toBlocks. Better algorithms would be:
          // - Re-updating SpokePoolClients only from new fromBlocks to old fromBlocks. Challenge here is to add a
          //   a utility function to SpokePoolClient to enable querying older events and inserting them correctly
          //   into the already-populated arrays of events.
          // - Only increase the lookback for the SpokePoolClient that will decrease the invalidBundleStartBlock
          //   the most.
          logger.debug({
            at: "Dataworker#index",
            message:
              "latest invalid bundle start blocks are later than latest executed root bundle's end blocks. Will increase update range and retry 😬",
            latestInvalidBundleStartBlocks,
            latestFullyExecutedBundleEndBlocks: bundleEndBlockMapping,
            oldDataworkerFastLookbackCount: config.dataworkerFastLookbackCount,
            newDataworkerFastLookbackCount: customConfig.dataworkerFastLookbackCount,
          });
        } else {
          logger.debug({
            at: "Dataworker#index",
            message:
              "Identified latest invalid bundle start blocks per chain that we will use to filter root bundles that can be proposed and validated",
            latestInvalidBundleStartBlocks,
            fromBlocks,
            toBlocks,
          });
          break;
        }
      }

      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled)
        await dataworker.validatePendingRootBundle(
          spokePoolClients,
          config.sendingDisputesEnabled,
          latestInvalidBundleStartBlocks
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });

      if (config.proposerEnabled)
        await dataworker.proposeRootBundle(
          spokePoolClients,
          config.rootBundleExecutionThreshold,
          config.sendingProposalsEnabled,
          latestInvalidBundleStartBlocks
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });

      if (config.executorEnabled) {
        const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

        await dataworker.executePoolRebalanceLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          latestInvalidBundleStartBlocks
        );

        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          latestInvalidBundleStartBlocks
        );
        await dataworker.executeRelayerRefundLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          latestInvalidBundleStartBlocks
        );
      } else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });

      await clients.multiCallerClient.executeTransactionQueue();

      logger.debug({ at: "Dataworker#index", message: `Time to loop: ${(Date.now() - loopStart) / 1000}s` });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    if (clients.configStoreClient.redisClient !== undefined) {
      // todo understand why redisClient isn't GCed automagically.
      logger.debug("Disconnecting from redis server.");
      clients.configStoreClient.redisClient.disconnect();
    }

    throw error;
  }
}
