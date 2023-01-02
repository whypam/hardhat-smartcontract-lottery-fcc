const { assert, expect } = require("chai")
const { getNamedAccounts, deployments, ethers, network } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Raffle Unit Tests", function () {
          // describe statement doesn't need async keyword
          let raffle, vrfCoordinatorV2Mock, raffleEntranceFee, deployer, interval
          const chainId = network.config.chainId

          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(["all"])
              raffle = await ethers.getContract("Raffle", deployer)
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              raffleEntranceFee = await raffle.getEntranceFee()
              interval = await raffle.getInterval()
          })

          describe("constructor", function () {
              it("Intitalizes the raffle correctly", async function () {
                  // Ideally we make our tests have just 1 assert per "it"
                  const raffleState = await raffle.getRaffleState()
                  assert.equal(raffleState.toString(), "0")
                  assert.equal(interval.toString(), networkConfig[chainId]["interval"])
              })
          })

          describe("enterRaffle", function () {
              it("Reverts when you don't pay enough", async function () {
                  await expect(raffle.enterRaffle()).to.be.revertedWith(
                      "Raffle__NotEnoughETHEntered"
                  )
              })
              it("Records players when they enter", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  const playerFromContract = await raffle.getPlayer(0)
                  assert.equal(playerFromContract, deployer)
              })
              it("Emit event on enter", async function () {
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.emit(
                      raffle,
                      "RaffleEnter"
                  )
              })
              it("Doesn't allow entrance when raffle is calculating", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  // simulate time passed when raffle entering CALCULATING state that not allow new raffle entrance
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  // We pretend to be a Chainlink Keeper
                  await raffle.performUpkeep([])
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.be.revertedWith(
                      "Raffle__NotOpen"
                  )
              })
          })

          describe("checkUpkeep", function () {
              it("Return false if people haven't sent any ETH", async function () {
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  // callStatic is a useful method that submits a state-changing transaction to an Ethereum node,
                  // but asks the node to simulate the state change, rather than to execute it.
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert(!upkeepNeeded)
              })
              it("Returns false if raffle isn't open", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  // simulate time passed when raffle entering CALCULATING state that not allow new raffle entrance
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  // We pretend to be a Chainlink Keeper
                  await raffle.performUpkeep([]) // [] or "0x" - to send a blank byte object
                  const raffleState = await raffle.getRaffleState()
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert.equal(raffleState.toString(), "1")
                  assert.equal(upkeepNeeded, false)
              })
              it("Returns false if enough time hasn't passed", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  // simulate time passed when raffle entering CALCULATING state that not allow new raffle entrance
                  await network.provider.send("evm_increaseTime", [interval.toNumber() - 5]) // to make the time longer to pass
                  await network.provider.send("evm_mine", []) // [] or "0x" - to send a blank byte object
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert(!upkeepNeeded)
              })
              it("Return true if enough time has passed, has players, eth, and is open", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  // simulate time passed when raffle entering CALCULATING state that not allow new raffle entrance
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]) // to make the time longer to pass
                  await network.provider.send("evm_mine", []) // [] or "0x" - to send a blank byte object
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert(upkeepNeeded)
              })
          })

          describe("performUpkeep", function () {
              it("It can only run if checkUpkeep is true", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const tx = await raffle.performUpkeep([])
                  assert(tx)
              })
              it("Reverts when checkUpkeep is false", async function () {
                  await expect(raffle.performUpkeep([])).to.be.revertedWith(
                      "Raffle__UpkeepNotNeeded"
                  )
              })
              it("Updates the raffle state, emits and event, and calls the vrf coordinator", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const txResponse = await raffle.performUpkeep([])
                  const txReceipt = await txResponse.wait(1)
                  const requestId = txReceipt.events[0].args.requestId
                  const raffleState = await raffle.getRaffleState()
                  // Ref: https://github.com/smartcontractkit/full-blockchain-solidity-course-js/discussions/1947
                  // In Raffler.sol, inside performUpkeep(), i_vrfCoordinator.requestRandomWords(), emit first event --> event[0]
                  // emit RequestedRaffleWinner(requestId), emit second event --> event[1]
                  // So in Raffle.test.js, it can reference either txReceipt.events[0].args.requestId or
                  // txReceipt.events[1].args.requestId, both will return the same requestId
                  // However, Raffle.sol will need to declare "event RandomWordsRequested(...)" to catch the event being emitted by
                  // i_vrfCoordinatorV2.requestRandomWords(...) in VRFCoordinatorV2Mock.sol
                  // Doing so, it is redundant to "emit RequestedRaffleWinner(requestId)"
                  // Thus, just do either one
                  // Removed "emit RequestedRaffleWinner(requestId)" from Raffle.sol
                  console.log(`event[0] - ${txReceipt.events[0].args.requestId}`)
                  //console.log(`event[1] - ${txReceipt.events[1].args.requestId}`)
                  assert(requestId.toNumber() > 0)
                  assert(raffleState.toString() == "1") // 0 = open, 1 = calculating
              })
          })

          describe("fulfillRandomWords", function () {
              beforeEach(async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
              })
              it("Can only be called after performUpkeep", async function () {
                  await expect(
                      vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address)
                  ).to.be.revertedWith("nonexistent request")
                  await expect(
                      vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address)
                  ).to.be.revertedWith("nonexistent request")
                  // In VRGCoordinatorV2Mock.sol, fulfillRandomWords() calls fulfillRandomWordsWithOverride() to check
                  // if (s_requests[_requestId].subId == 0) {
                  //  revert("nonexistent request");
                  //}
              })
              it("Picks a winner, resets the lottery, and sends money", async function () {
                  const additionalEntrants = 3
                  const startingAccountIndex = 1 // deployer = 0
                  const accounts = await ethers.getSigners() // for testing, get a list of signers from ethers
                  for (
                      let i = startingAccountIndex;
                      i < startingAccountIndex + additionalEntrants;
                      i++
                  ) {
                      const accountConnectedRaffle = raffle.connect(accounts[i]) // connect a signer to raffle contract
                      await accountConnectedRaffle.enterRaffle({ value: raffleEntranceFee })
                  }
                  const startingTimeStamp = await raffle.getLatestTimeStamp()

                  // performUpkeep (mock being Chainlink Keepers)
                  // fulfillRandomWords (mock being the Chainlink VRF)
                  // We will have to wait for the fulfillRandomWords to be called
                  console.log("Setting up Promise...")
                  await new Promise(async (resolve, reject) => {
                      // listen to "event WinnerPicked(address indexed winner);" in Raffle.sol
                      // "event WinnerPicked()" is triggered by "emit WinnerPicked(recentWinner);" in fulfillRandomWords()
                      console.log("Setting up Listener...")
                      raffle.once("WinnerPicked", async () => {
                          // set up listener
                          // assert throws an error if it fails, so we need to wrap
                          // it in a try/catch so that the promise returns event it it fails
                          console.log("Found the event!")
                          try {
                              const recentWinner = await raffle.getRecentWinner()
                              const raffleState = await raffle.getRaffleState()
                              const endingTimeStamp = await raffle.getLatestTimeStamp()
                              const numPlayers = await raffle.getNumberOfPlayers()
                              const winnerEndingBalance = await accounts[1].getBalance()
                              assert.equal(numPlayers.toString(), "0")
                              assert.equal(raffleState.toString(), "0")
                              assert(endingTimeStamp > startingTimeStamp)

                              // only after running the test and figuring who the winner is,
                              // then get the winnerStartingBalance below "const winnerStartingBalance = await accounts[1].getBalance()"
                              // and do the calculation here.
                              assert.equal(
                                  winnerEndingBalance.toString(),
                                  winnerStartingBalance.add(
                                      raffleEntranceFee
                                          .mul(additionalEntrants)
                                          .add(raffleEntranceFee)
                                          .toString()
                                  )
                              )
                              resolve() // if try passes, resolves the promise

                              //for finding who the winner is
                              //console.log(`The winner is ${recentWinner}`)
                              //console.log(accounts[0].address)
                              //console.log(accounts[1].address)
                              //console.log(accounts[2].address)
                              //console.log(accounts[3].address)
                          } catch (e) {
                              reject(e) // if try falils, rejects the promise
                          }
                      })
                      // Setting up the listener - "raffle.once("WinnerPicked, () => {})"
                      // Then, below, we will fire the event, and the listener will pick it up, and resolve
                      console.log("Entering Raffle...")
                      const tx = await raffle.performUpkeep([])
                      const txReceipt = await tx.wait(1)
                      console.log("Ok, time to wait...")
                      const winnerStartingBalance = await accounts[1].getBalance()
                      // When "vrfCoordinatorV2Mock.fulfillRandomWords" gets called in VRFCoordinatorV2Mock.sol,
                      // "fulfillRandomsWords()" in Raffle.sol will override it and "emit WinnerPicked(recentWinner);",
                      // then trigger "event WinnerPicked(address indexed winner);"
                      await vrfCoordinatorV2Mock.fulfillRandomWords(
                          txReceipt.events[0].args.requestId,
                          raffle.address
                      )
                  })
              })
          })
      })
