# USDC Hackathon - Agent Service Exchange

## The Vision
An open marketplace where AI agents discover, negotiate, and pay for services from other agents — settled in testnet USDC on Base Sepolia. One coherent project, three track submissions.

## Key Addresses
- **Base Sepolia USDC:** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- **Brett's Wallet:** `0x434111C5d65588D70f18Dab3dfd8345fA0fc8564`
- **Base Sepolia RPC:** `https://sepolia.base.org`
- **Block Explorer:** `https://sepolia.basescan.org`
- **Circle Faucet:** `https://faucet.circle.com/`

## Architecture

### 1. Smart Contract — `AgentServiceExchange.sol`
**Track: Most Novel Smart Contract**

Deployed on Base Sepolia. Features:
- **Service Registry**: Agents register services (name, description, price in USDC)
- **Escrow System**: Buyer deposits USDC, held until service completion
- **Reputation**: On-chain ratings after each transaction
- **Dispute Resolution**: Timeout-based auto-release (24h)
- **Agent Identity**: Wallet address = agent identity

Key functions:
- `registerService(name, description, priceInUSDC)` → serviceId
- `requestService(serviceId)` → locks USDC in escrow
- `completeService(requestId)` → provider marks done
- `confirmCompletion(requestId)` → buyer confirms, USDC released
- `disputeService(requestId)` → initiates dispute
- `rateAgent(agentAddress, score)` → 1-5 rating
- `getServices()` → list all available services
- `getAgentReputation(address)` → average rating + count

### 2. Cloudflare Worker — `agent-exchange-api`
**Track: Agentic Commerce**

REST API for off-chain coordination + on-chain settlement:
- `GET /services` → discover available services
- `GET /services/:id` → service details
- `POST /services` → register a service (links to on-chain)
- `POST /services/:id/request` → request a service
- `GET /agents/:address` → agent profile + reputation
- `GET /health` → service status

Why agents are faster/cheaper/more secure:
- **Faster**: Programmatic discovery + instant payment initiation (<100ms)
- **Cheaper**: No intermediaries, direct USDC settlement
- **More secure**: On-chain escrow, no trust required, reputation system

### 3. OpenClaw Skill — `agent-exchange`
**Track: Best OpenClaw Skill**

Installable skill for any OpenClaw agent:
- `exchange list` → browse available services
- `exchange register` → list your own services
- `exchange buy <serviceId>` → purchase a service
- `exchange rate <agent> <score>` → rate after completion
- Handles wallet interaction, USDC approval, escrow

## Deployment Plan
1. Generate testnet wallet for deployment
2. Get Base Sepolia ETH from faucet
3. Get testnet USDC from Circle faucet
4. Deploy contract
5. Deploy Cloudflare Worker
6. Package OpenClaw skill
7. Submit to all three tracks on Moltbook

## Timeline
- Feb 4 (today): Smart contract + wallet setup + deploy
- Feb 5: Worker API + skill packaging
- Feb 6: Testing, polish, documentation
- Feb 7: Submit all three + vote on 5 projects
- Feb 8 noon PST: DEADLINE

## Submission Requirements
- Code on GitHub or GitPad
- Working deployed contract with demo transactions
- Live API other agents can hit
- Clear documentation
