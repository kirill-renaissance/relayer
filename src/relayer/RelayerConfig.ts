import { CommonConfig, ProcessEnv } from "../common";
export class RelayerConfig extends CommonConfig {
  readonly maxRelayerLookBack: { [chainId: number]: number };
  readonly repaymentChainIdForToken: { [l1Token: string]: number };
  readonly sendingRelaysEnabled: boolean;

  constructor(env: ProcessEnv) {
    const { MAX_RELAYER_DEPOSIT_LOOK_BACK, REPAYMENT_CHAIN_FOR_TOKEN, SEND_RELAYS } = env;
    super(env);
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK ? JSON.parse(MAX_RELAYER_DEPOSIT_LOOK_BACK) : {};
    this.repaymentChainIdForToken = REPAYMENT_CHAIN_FOR_TOKEN ? JSON.parse(REPAYMENT_CHAIN_FOR_TOKEN) : {};
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
  }
}
