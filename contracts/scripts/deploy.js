const hre = require("hardhat");

async function main() {
  const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  
  console.log("Deploying AgentServiceExchange...");
  console.log("Network:", hre.network.name);
  console.log("USDC Address:", BASE_SEPOLIA_USDC);

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");

  const AgentServiceExchange = await hre.ethers.getContractFactory("AgentServiceExchange");
  const exchange = await AgentServiceExchange.deploy(BASE_SEPOLIA_USDC);
  await exchange.waitForDeployment();

  const address = await exchange.getAddress();
  console.log("\n✅ AgentServiceExchange deployed to:", address);
  console.log("Block explorer:", `https://sepolia.basescan.org/address/${address}`);
  
  // Register a demo service
  console.log("\nRegistering demo service...");
  const tx = await exchange.registerService(
    "AI Code Review",
    "Comprehensive code review with security analysis, best practices, and optimization suggestions. Powered by multi-model AI verification.",
    hre.ethers.parseUnits("5", 6) // 5 USDC
  );
  await tx.wait();
  console.log("✅ Demo service registered (ID: 1)");

  console.log("\n=== Deployment Summary ===");
  console.log("Contract:", address);
  console.log("USDC:", BASE_SEPOLIA_USDC);
  console.log("Network: Base Sepolia (chainId: 84532)");
  console.log("Demo Service: AI Code Review @ 5 USDC");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
