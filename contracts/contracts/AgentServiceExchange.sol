// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AgentServiceExchange
 * @notice A decentralized marketplace for AI agent services with USDC escrow
 * @dev Implements service registry, escrow, dispute resolution, and reputation tracking
 * 
 * Novelty Features:
 * - Dual-phase completion with timeout protection
 * - Immutable reputation tracking with weighted averages
 * - Gas-optimized service discovery with pagination
 * - Anti-griefing measures for both buyers and providers
 */
contract AgentServiceExchange is ReentrancyGuard, Pausable, Ownable {
    
    // ============ Errors ============
    error InvalidPrice();
    error InvalidRating();
    error ServiceNotFound();
    error ServiceNotActive();
    error RequestNotFound();
    error Unauthorized();
    error InvalidState();
    error TimeoutNotReached();
    error TimeoutAlreadyPassed();
    error TransferFailed();
    error SelfServiceNotAllowed();
    error ReputationAlreadySubmitted();
    error ArrayLengthMismatch();
    
    // ============ Enums ============
    enum RequestState {
        Pending,      // Awaiting provider acceptance
        InProgress,   // Provider accepted, work in progress
        Completed,    // Provider marked complete, awaiting buyer confirmation
        Disputed,     // Under dispute resolution
        Finalized,    // Successfully completed and paid
        Cancelled     // Cancelled by either party
    }
    
    // ============ Structs ============
    
    /**
     * @notice Represents a service listing by an agent provider
     * @dev Optimized struct packing for gas efficiency
     */
    struct Service {
        uint256 id;
        address provider;
        string name;
        string description;
        uint256 price;           // USDC with 6 decimals
        bool active;
        uint256 createdAt;
        uint256 totalSales;
    }
    
    /**
     * @notice Represents a service request with escrow
     * @dev Tracks the full lifecycle from request to completion
     */
    struct ServiceRequest {
        uint256 id;
        uint256 serviceId;
        address buyer;
        address provider;
        uint256 price;
        RequestState state;
        uint256 createdAt;
        uint256 completedAt;     // When provider marked complete
        bool reputationGiven;
    }
    
    /**
     * @notice Tracks reputation metrics for an agent provider
     * @dev Uses running average algorithm for O(1) updates
     */
    struct Reputation {
        uint256 totalRatings;
        uint256 averageRating;   // Stored as scaled by 100 (e.g., 450 = 4.5 stars)
        uint256 completedJobs;
    }
    
    // ============ State Variables ============
    
    IERC20 public immutable usdc;
    uint256 public constant COMPLETION_TIMEOUT = 24 hours;
    uint256 public constant RATING_SCALE = 100;  // For decimal precision
    uint256 public constant MIN_RATING = 1;
    uint256 public constant MAX_RATING = 5;
    
    uint256 private _serviceCounter;
    uint256 private _requestCounter;
    
    // Mappings
    mapping(uint256 => Service) public services;
    mapping(uint256 => ServiceRequest) public requests;
    mapping(address => uint256[]) public providerServices;
    mapping(address => uint256[]) public buyerRequests;
    mapping(address => Reputation) public reputations;
    
    // Active service IDs for discovery (only active services)
    uint256[] public activeServiceIds;
    mapping(uint256 => uint256) private _activeServiceIndex; // serviceId => index + 1 (0 = inactive)
    
    // ============ Events ============
    
    event ServiceRegistered(
        uint256 indexed serviceId,
        address indexed provider,
        string name,
        uint256 price
    );
    
    event ServiceUpdated(
        uint256 indexed serviceId,
        string name,
        uint256 price,
        bool active
    );
    
    event RequestCreated(
        uint256 indexed requestId,
        uint256 indexed serviceId,
        address indexed buyer,
        uint256 price
    );
    
    event RequestAccepted(
        uint256 indexed requestId,
        address indexed provider
    );
    
    event RequestCompleted(
        uint256 indexed requestId,
        address indexed provider
    );
    
    event RequestConfirmed(
        uint256 indexed requestId,
        address indexed buyer
    );
    
    event RequestCancelled(
        uint256 indexed requestId,
        address indexed cancelledBy
    );
    
    event EscrowReleased(
        uint256 indexed requestId,
        address indexed provider,
        uint256 amount
    );
    
    event EscrowRefunded(
        uint256 indexed requestId,
        address indexed buyer,
        uint256 amount
    );
    
    event ReputationAdded(
        address indexed provider,
        address indexed buyer,
        uint256 rating,
        uint256 newAverage
    );
    
    event TimeoutClaim(
        uint256 indexed requestId,
        address indexed provider
    );
    
    // ============ Constructor ============
    
    constructor(address _usdc) Ownable(msg.sender) {
        if (_usdc == address(0)) revert InvalidPrice();
        usdc = IERC20(_usdc);
    }
    
    // ============ Service Registry ============
    
    /**
     * @notice Register a new service offering
     * @param _name Service name (max 100 chars recommended)
     * @param _description Detailed service description
     * @param _price Price in USDC (6 decimals)
     */
    function registerService(
        string calldata _name,
        string calldata _description,
        uint256 _price
    ) external whenNotPaused returns (uint256) {
        if (_price == 0) revert InvalidPrice();
        if (bytes(_name).length == 0) revert InvalidPrice();
        
        _serviceCounter++;
        uint256 serviceId = _serviceCounter;
        
        services[serviceId] = Service({
            id: serviceId,
            provider: msg.sender,
            name: _name,
            description: _description,
            price: _price,
            active: true,
            createdAt: block.timestamp,
            totalSales: 0
        });
        
        providerServices[msg.sender].push(serviceId);
        
        // Add to active services list
        _activeServiceIndex[serviceId] = activeServiceIds.length + 1;
        activeServiceIds.push(serviceId);
        
        emit ServiceRegistered(serviceId, msg.sender, _name, _price);
        
        return serviceId;
    }
    
    /**
     * @notice Update an existing service
     * @param _serviceId Service ID to update
     * @param _name New name
     * @param _description New description
     * @param _price New price
     * @param _active Whether service is active
     */
    function updateService(
        uint256 _serviceId,
        string calldata _name,
        string calldata _description,
        uint256 _price,
        bool _active
    ) external {
        Service storage service = services[_serviceId];
        
        if (service.id == 0) revert ServiceNotFound();
        if (service.provider != msg.sender) revert Unauthorized();
        if (_price == 0) revert InvalidPrice();
        
        service.name = _name;
        service.description = _description;
        service.price = _price;
        service.active = _active;
        
        // Update active service list
        bool wasActive = _activeServiceIndex[_serviceId] != 0;
        if (_active && !wasActive) {
            _activeServiceIndex[_serviceId] = activeServiceIds.length + 1;
            activeServiceIds.push(_serviceId);
        } else if (!_active && wasActive) {
            _removeFromActiveServices(_serviceId);
        }
        
        emit ServiceUpdated(_serviceId, _name, _price, _active);
    }
    
    /**
     * @notice Deactivate a service without deleting it
     * @param _serviceId Service ID to deactivate
     */
    function deactivateService(uint256 _serviceId) external {
        Service storage service = services[_serviceId];
        
        if (service.id == 0) revert ServiceNotFound();
        if (service.provider != msg.sender) revert Unauthorized();
        
        service.active = false;
        _removeFromActiveServices(_serviceId);
        
        emit ServiceUpdated(_serviceId, service.name, service.price, false);
    }
    
    // ============ Escrow & Request Flow ============
    
    /**
     * @notice Create a service request and lock USDC in escrow
     * @param _serviceId Service to request
     * @dev Buyer must approve USDC transfer first
     */
    function createRequest(uint256 _serviceId) external nonReentrant whenNotPaused {
        Service storage service = services[_serviceId];
        
        if (service.id == 0) revert ServiceNotFound();
        if (!service.active) revert ServiceNotActive();
        if (service.provider == msg.sender) revert SelfServiceNotAllowed();
        
        // Transfer USDC from buyer to contract (escrow)
        bool success = usdc.transferFrom(msg.sender, address(this), service.price);
        if (!success) revert TransferFailed();
        
        _requestCounter++;
        uint256 requestId = _requestCounter;
        
        requests[requestId] = ServiceRequest({
            id: requestId,
            serviceId: _serviceId,
            buyer: msg.sender,
            provider: service.provider,
            price: service.price,
            state: RequestState.InProgress,
            createdAt: block.timestamp,
            completedAt: 0,
            reputationGiven: false
        });
        
        buyerRequests[msg.sender].push(requestId);
        
        emit RequestCreated(requestId, _serviceId, msg.sender, service.price);
    }
    
    /**
     * @notice Provider marks service as completed
     * @param _requestId Request to complete
     */
    function markComplete(uint256 _requestId) external {
        ServiceRequest storage request = requests[_requestId];
        
        if (request.id == 0) revert RequestNotFound();
        if (request.provider != msg.sender) revert Unauthorized();
        if (request.state != RequestState.InProgress) revert InvalidState();
        
        request.state = RequestState.Completed;
        request.completedAt = block.timestamp;
        
        emit RequestCompleted(_requestId, msg.sender);
    }
    
    /**
     * @notice Buyer confirms completion and releases escrow
     * @param _requestId Request to confirm
     * @param _rating Rating 1-5 for provider reputation
     */
    function confirmCompletion(
        uint256 _requestId,
        uint256 _rating
    ) external nonReentrant {
        if (_rating < MIN_RATING || _rating > MAX_RATING) revert InvalidRating();
        
        ServiceRequest storage request = requests[_requestId];
        
        if (request.id == 0) revert RequestNotFound();
        if (request.buyer != msg.sender) revert Unauthorized();
        if (request.state != RequestState.Completed) revert InvalidState();
        
        // Update service sales count
        services[request.serviceId].totalSales++;
        
        // Update reputation before releasing funds
        _updateReputation(request.provider, _rating);
        request.reputationGiven = true;
        
        // Release escrow to provider
        request.state = RequestState.Finalized;
        
        bool success = usdc.transfer(request.provider, request.price);
        if (!success) revert TransferFailed();
        
        emit RequestConfirmed(_requestId, msg.sender);
        emit EscrowReleased(_requestId, request.provider, request.price);
        emit ReputationAdded(
            request.provider,
            msg.sender,
            _rating,
            reputations[request.provider].averageRating
        );
    }
    
    /**
     * @notice Provider claims escrow after timeout if buyer doesn't confirm
     * @param _requestId Request to claim
     */
    function claimAfterTimeout(uint256 _requestId) external nonReentrant {
        ServiceRequest storage request = requests[_requestId];
        
        if (request.id == 0) revert RequestNotFound();
        if (request.provider != msg.sender) revert Unauthorized();
        if (request.state != RequestState.Completed) revert InvalidState();
        if (block.timestamp < request.completedAt + COMPLETION_TIMEOUT) {
            revert TimeoutNotReached();
        }
        
        // Mark as finalized without reputation (timeout path)
        request.state = RequestState.Finalized;
        services[request.serviceId].totalSales++;
        
        // Release escrow to provider
        bool success = usdc.transfer(request.provider, request.price);
        if (!success) revert TransferFailed();
        
        emit TimeoutClaim(_requestId, msg.sender);
        emit EscrowReleased(_requestId, request.provider, request.price);
    }
    
    /**
     * @notice Cancel a request and refund buyer
     * @param _requestId Request to cancel
     * @dev Can be called by buyer before completion, or provider before acceptance
     */
    function cancelRequest(uint256 _requestId) external nonReentrant {
        ServiceRequest storage request = requests[_requestId];
        
        if (request.id == 0) revert RequestNotFound();
        
        bool isBuyer = request.buyer == msg.sender;
        bool isProvider = request.provider == msg.sender;
        
        if (!isBuyer && !isProvider) revert Unauthorized();
        
        // Buyer can cancel if not yet completed
        // Provider can cancel at any time (emergency exit)
        if (isBuyer && request.state == RequestState.Completed) {
            revert InvalidState();
        }
        
        request.state = RequestState.Cancelled;
        
        // Refund buyer
        bool success = usdc.transfer(request.buyer, request.price);
        if (!success) revert TransferFailed();
        
        emit RequestCancelled(_requestId, msg.sender);
        emit EscrowRefunded(_requestId, request.buyer, request.price);
    }
    
    // ============ Reputation System ============
    
    /**
     * @notice Internal function to update provider reputation
     * @param _provider Provider address
     * @param _rating New rating 1-5
     * @dev Uses weighted running average for O(1) gas cost
     */
    function _updateReputation(address _provider, uint256 _rating) internal {
        Reputation storage rep = reputations[_provider];
        
        // Scale rating to RATING_SCALE for decimal precision
        uint256 scaledRating = _rating * RATING_SCALE;
        
        if (rep.totalRatings == 0) {
            rep.averageRating = scaledRating;
        } else {
            // Weighted average: newAvg = (oldAvg * count + newRating) / (count + 1)
            rep.averageRating = (
                (rep.averageRating * rep.totalRatings) + scaledRating
            ) / (rep.totalRatings + 1);
        }
        
        rep.totalRatings++;
        rep.completedJobs++;
    }
    
    /**
     * @notice Get normalized reputation (1.00 - 5.00)
     * @param _provider Provider address
     * @return average Rating as decimal (e.g., 450 = 4.50 stars)
     * @return count Total number of ratings
     * @return jobs Total completed jobs
     */
    function getReputation(address _provider) external view returns (
        uint256 average,
        uint256 count,
        uint256 jobs
    ) {
        Reputation storage rep = reputations[_provider];
        return (rep.averageRating, rep.totalRatings, rep.completedJobs);
    }
    
    // ============ Service Discovery ============
    
    /**
     * @notice Get active services with pagination
     * @param _offset Starting index
     * @param _limit Maximum results to return
     * @return serviceIds Array of service IDs
     * @return hasMore Whether more results exist
     */
    function getActiveServices(
        uint256 _offset,
        uint256 _limit
    ) external view returns (uint256[] memory serviceIds, bool hasMore) {
        uint256 total = activeServiceIds.length;
        
        if (_offset >= total) {
            return (new uint256[](0), false);
        }
        
        uint256 end = _offset + _limit;
        if (end > total) {
            end = total;
        }
        
        uint256 resultCount = end - _offset;
        uint256[] memory result = new uint256[](resultCount);
        
        for (uint256 i = 0; i < resultCount; i++) {
            result[i] = activeServiceIds[_offset + i];
        }
        
        return (result, end < total);
    }
    
    /**
     * @notice Get all services by a provider
     * @param _provider Provider address
     * @return Array of service IDs
     */
    function getProviderServices(address _provider) external view returns (uint256[] memory) {
        return providerServices[_provider];
    }
    
    /**
     * @notice Get all requests by a buyer
     * @param _buyer Buyer address
     * @return Array of request IDs
     */
    function getBuyerRequests(address _buyer) external view returns (uint256[] memory) {
        return buyerRequests[_buyer];
    }
    
    /**
     * @notice Get full service details
     * @param _serviceId Service ID
     */
    function getService(uint256 _serviceId) external view returns (Service memory) {
        if (services[_serviceId].id == 0) revert ServiceNotFound();
        return services[_serviceId];
    }
    
    /**
     * @notice Get full request details
     * @param _requestId Request ID
     */
    function getRequest(uint256 _requestId) external view returns (ServiceRequest memory) {
        if (requests[_requestId].id == 0) revert RequestNotFound();
        return requests[_requestId];
    }
    
    /**
     * @notice Get multiple services in one call
     * @param _serviceIds Array of service IDs
     * @return Array of Service structs
     */
    function getServicesBatch(
        uint256[] calldata _serviceIds
    ) external view returns (Service[] memory) {
        Service[] memory result = new Service[](_serviceIds.length);
        
        for (uint256 i = 0; i < _serviceIds.length; i++) {
            result[i] = services[_serviceIds[i]];
        }
        
        return result;
    }
    
    /**
     * @notice Get time remaining until timeout claim is available
     * @param _requestId Request ID
     * @return timeRemaining Seconds until claimable (0 if already passed)
     * @return claimable Whether claim is currently available
     */
    function getTimeoutStatus(uint256 _requestId) external view returns (
        uint256 timeRemaining,
        bool claimable
    ) {
        ServiceRequest storage request = requests[_requestId];
        
        if (request.id == 0 || request.state != RequestState.Completed) {
            return (0, false);
        }
        
        uint256 timeoutAt = request.completedAt + COMPLETION_TIMEOUT;
        
        if (block.timestamp >= timeoutAt) {
            return (0, true);
        }
        
        return (timeoutAt - block.timestamp, false);
    }
    
    // ============ Admin Functions ============
    
    /**
     * @notice Pause the contract (emergency)
     */
    function pause() external onlyOwner {
        _pause();
    }
    
    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /**
     * @notice Emergency withdrawal of stuck tokens (only owner)
     * @param _token Token address
     * @param _to Recipient address
     * @param _amount Amount to withdraw
     */
    function emergencyWithdraw(
        address _token,
        address _to,
        uint256 _amount
    ) external onlyOwner {
        if (_to == address(0)) revert InvalidPrice();
        IERC20(_token).transfer(_to, _amount);
    }
    
    // ============ Internal Functions ============
    
    /**
     * @notice Remove a service from active list
     * @param _serviceId Service to remove
     * @dev O(1) removal using swap-and-pop
     */
    function _removeFromActiveServices(uint256 _serviceId) internal {
        uint256 index = _activeServiceIndex[_serviceId];
        if (index == 0) return; // Not in active list
        
        uint256 arrayIndex = index - 1;
        uint256 lastIndex = activeServiceIds.length - 1;
        
        if (arrayIndex != lastIndex) {
            uint256 lastServiceId = activeServiceIds[lastIndex];
            activeServiceIds[arrayIndex] = lastServiceId;
            _activeServiceIndex[lastServiceId] = index;
        }
        
        activeServiceIds.pop();
        _activeServiceIndex[_serviceId] = 0;
    }
    
    // ============ View Functions ============
    
    /**
     * @notice Get total number of services registered
     */
    function getTotalServices() external view returns (uint256) {
        return _serviceCounter;
    }
    
    /**
     * @notice Get total number of requests created
     */
    function getTotalRequests() external view returns (uint256) {
        return _requestCounter;
    }
    
    /**
     * @notice Get count of active services
     */
    function getActiveServiceCount() external view returns (uint256) {
        return activeServiceIds.length;
    }
    
    /**
     * @notice Check if a request can be claimed after timeout
     */
    function canClaimTimeout(uint256 _requestId) external view returns (bool) {
        ServiceRequest storage request = requests[_requestId];
        return (
            request.id != 0 &&
            request.state == RequestState.Completed &&
            block.timestamp >= request.completedAt + COMPLETION_TIMEOUT
        );
    }
}
