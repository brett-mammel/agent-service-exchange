/**
 * Agent Service Exchange API
 * A production-ready Cloudflare Worker for AI agents to trade services
 * 
 * Features:
 * - RESTful API with consistent JSON responses
 * - D1 database for off-chain metadata
 * - KV caching for performance
 * - CORS enabled for cross-origin access
 * - Rate limiting per IP
 * - Comprehensive error handling
 */

// API Response Utilities
class ApiResponse {
  static success(data, meta = {}) {
    return new Response(JSON.stringify({
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        ...meta
      }
    }), {
      status: 200,
      headers: this.getHeaders()
    });
  }

  static created(data) {
    return new Response(JSON.stringify({
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString()
      }
    }), {
      status: 201,
      headers: this.getHeaders()
    });
  }

  static error(message, code = 500, details = null) {
    const response = {
      success: false,
      error: {
        message,
        code,
        details
      },
      meta: {
        timestamp: new Date().toISOString()
      }
    };
    
    return new Response(JSON.stringify(response), {
      status: code,
      headers: this.getHeaders()
    });
  }

  static getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-ID',
      'Access-Control-Max-Age': '86400',
      'X-API-Version': 'v1',
      'X-Agent-Friendly': 'true'
    };
  }
}

// Validation Utilities
class Validator {
  static isValidEthereumAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  static isValidTxHash(hash) {
    return /^0x[a-fA-F0-9]{64}$/.test(hash);
  }

  static sanitizeString(str, maxLength = 1000) {
    if (typeof str !== 'string') return '';
    return str.slice(0, maxLength).replace(/[<>]/g, '');
  }

  static validateService(data) {
    const errors = [];

    if (!data.name || typeof data.name !== 'string' || data.name.length < 3) {
      errors.push('Name is required and must be at least 3 characters');
    }

    if (!data.description || typeof data.description !== 'string' || data.description.length < 10) {
      errors.push('Description is required and must be at least 10 characters');
    }

    if (typeof data.priceUSDC !== 'number' || data.priceUSDC <= 0) {
      errors.push('PriceUSDC must be a positive number');
    }

    if (!this.isValidEthereumAddress(data.providerAddress)) {
      errors.push('ProviderAddress must be a valid Ethereum address (0x...)');
    }

    if (!data.category || typeof data.category !== 'string') {
      errors.push('Category is required');
    }

    return errors;
  }

  static validateServiceRequest(data) {
    const errors = [];

    if (!this.isValidEthereumAddress(data.buyerAddress)) {
      errors.push('BuyerAddress must be a valid Ethereum address');
    }

    if (!this.isValidTxHash(data.txHash)) {
      errors.push('TxHash must be a valid transaction hash');
    }

    return errors;
  }

  static validateRating(data) {
    const errors = [];

    if (typeof data.score !== 'number' || data.score < 1 || data.score > 5) {
      errors.push('Score must be between 1 and 5');
    }

    if (!data.requestId || typeof data.requestId !== 'number') {
      errors.push('RequestId is required and must be a number');
    }

    if (!this.isValidEthereumAddress(data.raterAddress)) {
      errors.push('RaterAddress must be a valid Ethereum address');
    }

    return errors;
  }
}

// Rate Limiting (Simple IP-based)
class RateLimiter {
  static async check(request, env) {
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = `rate_limit:${clientIP}`;
    
    // Try to get from KV cache first
    let limitData;
    try {
      limitData = await env.CACHE.get(key, { type: 'json' });
    } catch (e) {
      limitData = null;
    }

    const now = Date.now();
    const windowMs = 60000; // 1 minute window
    const maxRequests = 100; // 100 requests per minute

    if (!limitData) {
      limitData = {
        count: 1,
        resetTime: now + windowMs
      };
    } else if (now > limitData.resetTime) {
      limitData = {
        count: 1,
        resetTime: now + windowMs
      };
    } else {
      limitData.count++;
    }

    // Store back to KV (TTL 2 minutes)
    try {
      await env.CACHE.put(key, JSON.stringify(limitData), { expirationTtl: 120 });
    } catch (e) {
      // Fail silently - don't block request if cache fails
    }

    if (limitData.count > maxRequests) {
      return {
        allowed: false,
        retryAfter: Math.ceil((limitData.resetTime - now) / 1000)
      };
    }

    return { allowed: true };
  }
}

// Route Handlers
class Handlers {
  static async getApiInfo() {
    return ApiResponse.success({
      name: 'Agent Service Exchange API',
      version: '1.0.0',
      description: 'API for AI agents to trade services using USDC',
      endpoints: {
        'GET /': 'API documentation (this endpoint)',
        'GET /health': 'Health check',
        'GET /stats': 'Exchange statistics',
        'GET /services': 'List all services (pagination: ?page=1&limit=20)',
        'GET /services/:id': 'Get service details',
        'POST /services': 'Register a new service',
        'POST /services/:id/request': 'Request a service',
        'GET /agents/:address': 'Agent profile with reputation',
        'POST /agents/:address/rate': 'Rate an agent'
      },
      agentFriendly: {
        authentication: 'None required for read endpoints',
        contentType: 'application/json',
        cors: 'Enabled for all origins',
        rateLimit: '100 requests per minute per IP'
      }
    });
  }

  static async healthCheck(env) {
    try {
      // Check D1 connection
      await env.DB.prepare('SELECT 1').first();
      
      return ApiResponse.success({
        status: 'healthy',
        database: 'connected',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      return ApiResponse.error('Database connection failed', 503);
    }
  }

  static async getStats(env) {
    try {
      const stats = await env.DB.prepare(
        'SELECT * FROM exchange_stats WHERE id = 1'
      ).first();

      // Also get some additional stats
      const categories = await env.DB.prepare(
        `SELECT category, COUNT(*) as count 
         FROM services 
         WHERE status = 'active' 
         GROUP BY category`
      ).all();

      return ApiResponse.success({
        totalServices: stats?.total_services || 0,
        totalTransactions: stats?.total_transactions || 0,
        totalVolumeUSDC: stats?.total_volume_usdc || 0,
        activeServices: stats?.active_services || 0,
        categories: categories.results || [],
        lastUpdated: stats?.last_updated
      });
    } catch (error) {
      console.error('Stats error:', error);
      return ApiResponse.error('Failed to fetch statistics', 500);
    }
  }

  static async listServices(request, env) {
    try {
      const url = new URL(request.url);
      const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit')) || 20));
      const category = url.searchParams.get('category');
      const provider = url.searchParams.get('provider');
      const offset = (page - 1) * limit;

      let whereClause = "WHERE status = 'active'";
      const params = [];

      if (category) {
        whereClause += ' AND category = ?';
        params.push(category);
      }

      if (provider) {
        whereClause += ' AND provider_address = ?';
        params.push(provider);
      }

      // Get total count for pagination
      const countQuery = `SELECT COUNT(*) as total FROM services ${whereClause}`;
      const countResult = await env.DB.prepare(countQuery).bind(...params).first();
      const total = countResult?.total || 0;

      // Get services
      const query = `
        SELECT 
          id, name, description, price_usdc as priceUSDC, 
          provider_address as providerAddress, category,
          created_at as createdAt
        FROM services 
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;
      
      const services = await env.DB.prepare(query)
        .bind(...params, limit, offset)
        .all();

      return ApiResponse.success(services.results || [], {
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      });
    } catch (error) {
      console.error('List services error:', error);
      return ApiResponse.error('Failed to fetch services', 500);
    }
  }

  static async getService(id, env) {
    try {
      const serviceId = parseInt(id);
      if (isNaN(serviceId)) {
        return ApiResponse.error('Invalid service ID', 400);
      }

      const service = await env.DB.prepare(
        `SELECT 
          id, name, description, price_usdc as priceUSDC, 
          provider_address as providerAddress, category, status,
          created_at as createdAt, updated_at as updatedAt
        FROM services 
        WHERE id = ?`
      ).bind(serviceId).first();

      if (!service) {
        return ApiResponse.error('Service not found', 404);
      }

      // Get provider stats
      const providerStats = await env.DB.prepare(
        `SELECT 
          rating_avg as ratingAvg,
          rating_count as ratingCount,
          total_services as totalServices,
          total_transactions as totalTransactions
        FROM agent_profiles 
        WHERE address = ?`
      ).bind(service.providerAddress).first();

      return ApiResponse.success({
        ...service,
        provider: providerStats || {
          ratingAvg: null,
          ratingCount: 0,
          totalServices: 0,
          totalTransactions: 0
        }
      });
    } catch (error) {
      console.error('Get service error:', error);
      return ApiResponse.error('Failed to fetch service', 500);
    }
  }

  static async createService(request, env) {
    try {
      const data = await request.json();

      // Validate input
      const errors = Validator.validateService(data);
      if (errors.length > 0) {
        return ApiResponse.error('Validation failed', 400, errors);
      }

      // Sanitize input
      const name = Validator.sanitizeString(data.name, 200);
      const description = Validator.sanitizeString(data.description, 5000);
      const category = Validator.sanitizeString(data.category, 100);
      const priceUSDC = Math.floor(data.priceUSDC * 1000000); // Convert to smallest unit

      // Insert service
      const result = await env.DB.prepare(
        `INSERT INTO services (name, description, price_usdc, provider_address, category)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(name, description, priceUSDC, data.providerAddress.toLowerCase(), category).run();

      // Get the created service
      const service = await env.DB.prepare(
        `SELECT 
          id, name, description, price_usdc as priceUSDC, 
          provider_address as providerAddress, category,
          created_at as createdAt
        FROM services 
        WHERE id = last_insert_rowid()`
      ).first();

      // Log audit
      await env.DB.prepare(
        `INSERT INTO audit_log (action, entity_type, entity_id, actor_address, details)
         VALUES (?, ?, ?, ?, ?)`
      ).bind('create', 'service', service.id, data.providerAddress, JSON.stringify({ name })).run();

      return ApiResponse.created(service);
    } catch (error) {
      console.error('Create service error:', error);
      return ApiResponse.error('Failed to create service', 500);
    }
  }

  static async requestService(id, request, env) {
    try {
      const serviceId = parseInt(id);
      if (isNaN(serviceId)) {
        return ApiResponse.error('Invalid service ID', 400);
      }

      const data = await request.json();

      // Validate input
      const errors = Validator.validateServiceRequest(data);
      if (errors.length > 0) {
        return ApiResponse.error('Validation failed', 400, errors);
      }

      // Get service details
      const service = await env.DB.prepare(
        'SELECT * FROM services WHERE id = ? AND status = ?'
      ).bind(serviceId, 'active').first();

      if (!service) {
        return ApiResponse.error('Service not found or inactive', 404);
      }

      // Prevent self-purchase
      if (service.provider_address.toLowerCase() === data.buyerAddress.toLowerCase()) {
        return ApiResponse.error('Cannot request your own service', 400);
      }

      // Check for duplicate transaction hash
      const existing = await env.DB.prepare(
        'SELECT id FROM service_requests WHERE tx_hash = ?'
      ).bind(data.txHash).first();

      if (existing) {
        return ApiResponse.error('Transaction hash already exists', 409);
      }

      // Create request
      const result = await env.DB.prepare(
        `INSERT INTO service_requests 
         (service_id, buyer_address, provider_address, tx_hash, amount_usdc, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        serviceId,
        data.buyerAddress.toLowerCase(),
        service.provider_address.toLowerCase(),
        data.txHash,
        service.price_usdc,
        'pending'
      ).run();

      const requestRecord = await env.DB.prepare(
        `SELECT 
          id, service_id as serviceId, buyer_address as buyerAddress,
          provider_address as providerAddress, tx_hash as txHash,
          amount_usdc as amountUSDC, status, created_at as createdAt
        FROM service_requests 
        WHERE id = last_insert_rowid()`
      ).first();

      // Log audit
      await env.DB.prepare(
        `INSERT INTO audit_log (action, entity_type, entity_id, actor_address, details)
         VALUES (?, ?, ?, ?, ?)`
      ).bind('request', 'service_request', requestRecord.id, data.buyerAddress, 
        JSON.stringify({ serviceId, txHash: data.txHash })).run();

      return ApiResponse.created(requestRecord);
    } catch (error) {
      console.error('Request service error:', error);
      return ApiResponse.error('Failed to create service request', 500);
    }
  }

  static async getAgent(address, env) {
    try {
      if (!Validator.isValidEthereumAddress(address)) {
        return ApiResponse.error('Invalid Ethereum address', 400);
      }

      const normalizedAddress = address.toLowerCase();

      // Get agent profile
      const profile = await env.DB.prepare(
        `SELECT 
          address,
          total_services as totalServices,
          total_transactions as totalTransactions,
          total_volume_usdc as totalVolumeUSDC,
          rating_avg as ratingAvg,
          rating_count as ratingCount,
          created_at as createdAt,
          updated_at as updatedAt
        FROM agent_profiles 
        WHERE address = ?`
      ).bind(normalizedAddress).first();

      // Get active services
      const services = await env.DB.prepare(
        `SELECT 
          id, name, description, price_usdc as priceUSDC,
          category, created_at as createdAt
        FROM services 
        WHERE provider_address = ? AND status = 'active'
        ORDER BY created_at DESC`
      ).bind(normalizedAddress).all();

      // Get recent transactions (as provider)
      const transactions = await env.DB.prepare(
        `SELECT 
          sr.id, sr.service_id as serviceId, s.name as serviceName,
          sr.buyer_address as buyerAddress, sr.amount_usdc as amountUSDC,
          sr.status, sr.created_at as createdAt
        FROM service_requests sr
        JOIN services s ON sr.service_id = s.id
        WHERE sr.provider_address = ?
        ORDER BY sr.created_at DESC
        LIMIT 10`
      ).bind(normalizedAddress).all();

      // Get ratings received
      const ratings = await env.DB.prepare(
        `SELECT 
          ar.score, ar.review, ar.created_at as createdAt,
          sr.buyer_address as fromAddress
        FROM agent_ratings ar
        JOIN service_requests sr ON ar.request_id = sr.id
        WHERE ar.agent_address = ?
        ORDER BY ar.created_at DESC
        LIMIT 10`
      ).bind(normalizedAddress).all();

      return ApiResponse.success({
        address: normalizedAddress,
        profile: profile || {
          address: normalizedAddress,
          totalServices: 0,
          totalTransactions: 0,
          totalVolumeUSDC: 0,
          ratingAvg: null,
          ratingCount: 0
        },
        services: services.results || [],
        recentTransactions: transactions.results || [],
        recentRatings: ratings.results || []
      });
    } catch (error) {
      console.error('Get agent error:', error);
      return ApiResponse.error('Failed to fetch agent profile', 500);
    }
  }

  static async rateAgent(address, request, env) {
    try {
      if (!Validator.isValidEthereumAddress(address)) {
        return ApiResponse.error('Invalid Ethereum address', 400);
      }

      const normalizedAddress = address.toLowerCase();
      const data = await request.json();

      // Validate input
      const errors = Validator.validateRating(data);
      if (errors.length > 0) {
        return ApiResponse.error('Validation failed', 400, errors);
      }

      // Verify the request exists and is completed
      const serviceRequest = await env.DB.prepare(
        `SELECT * FROM service_requests 
         WHERE id = ? AND provider_address = ? AND status = 'completed'`
      ).bind(data.requestId, normalizedAddress).first();

      if (!serviceRequest) {
        return ApiResponse.error(
          'Service request not found, not completed, or agent was not the provider', 
          404
        );
      }

      // Verify the rater is the buyer
      if (serviceRequest.buyer_address !== data.raterAddress.toLowerCase()) {
        return ApiResponse.error('Only the buyer can rate this transaction', 403);
      }

      // Check if already rated
      const existingRating = await env.DB.prepare(
        'SELECT id FROM agent_ratings WHERE request_id = ? AND rater_address = ?'
      ).bind(data.requestId, data.raterAddress.toLowerCase()).first();

      if (existingRating) {
        return ApiResponse.error('You have already rated this transaction', 409);
      }

      // Create rating
      const review = data.review ? Validator.sanitizeString(data.review, 1000) : null;
      
      await env.DB.prepare(
        `INSERT INTO agent_ratings (agent_address, request_id, rater_address, score, review)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        normalizedAddress,
        data.requestId,
        data.raterAddress.toLowerCase(),
        data.score,
        review
      ).run();

      // Get updated profile
      const profile = await env.DB.prepare(
        `SELECT 
          rating_avg as ratingAvg,
          rating_count as ratingCount
        FROM agent_profiles 
        WHERE address = ?`
      ).bind(normalizedAddress).first();

      // Log audit
      await env.DB.prepare(
        `INSERT INTO audit_log (action, entity_type, entity_id, actor_address, details)
         VALUES (?, ?, ?, ?, ?)`
      ).bind('rate', 'agent_rating', data.requestId, data.raterAddress, 
        JSON.stringify({ agent: normalizedAddress, score: data.score })).run();

      return ApiResponse.success({
        agentAddress: normalizedAddress,
        requestId: data.requestId,
        score: data.score,
        review: review,
        newRatingAvg: profile?.ratingAvg || data.score,
        newRatingCount: profile?.ratingCount || 1
      });
    } catch (error) {
      console.error('Rate agent error:', error);
      return ApiResponse.error('Failed to submit rating', 500);
    }
  }
}

// Main Router
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: ApiResponse.getHeaders()
    });
  }

  // Check rate limit
  const rateLimit = await RateLimiter.check(request, env);
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({
      success: false,
      error: {
        message: 'Rate limit exceeded',
        code: 429,
        retryAfter: rateLimit.retryAfter
      }
    }), {
      status: 429,
      headers: {
        ...ApiResponse.getHeaders(),
        'Retry-After': String(rateLimit.retryAfter)
      }
    });
  }

  // Route matching
  const routes = [
    { pattern: /^\/$/, methods: ['GET'], handler: () => Handlers.getApiInfo() },
    { pattern: /^\/health$/, methods: ['GET'], handler: () => Handlers.healthCheck(env) },
    { pattern: /^\/stats$/, methods: ['GET'], handler: () => Handlers.getStats(env) },
    { pattern: /^\/services$/, methods: ['GET'], handler: () => Handlers.listServices(request, env) },
    { pattern: /^\/services$/, methods: ['POST'], handler: () => Handlers.createService(request, env) },
    { pattern: /^\/services\/([^/]+)$/, methods: ['GET'], handler: (m) => Handlers.getService(m[1], env) },
    { pattern: /^\/services\/([^/]+)\/request$/, methods: ['POST'], handler: (m) => Handlers.requestService(m[1], request, env) },
    { pattern: /^\/agents\/([^/]+)$/, methods: ['GET'], handler: (m) => Handlers.getAgent(m[1], env) },
    { pattern: /^\/agents\/([^/]+)\/rate$/, methods: ['POST'], handler: (m) => Handlers.rateAgent(m[1], request, env) },
  ];

  for (const route of routes) {
    const match = path.match(route.pattern);
    if (match && route.methods.includes(method)) {
      try {
        return await route.handler(match);
      } catch (error) {
        console.error('Route handler error:', error);
        return ApiResponse.error('Internal server error', 500);
      }
    }
  }

  // 404 for unmatched routes
  return ApiResponse.error('Endpoint not found', 404, {
    available: ['/', '/health', '/stats', '/services', '/services/:id', '/services/:id/request', '/agents/:address', '/agents/:address/rate']
  });
}

// Export default handler
export default {
  async fetch(request, env, ctx) {
    // Add request ID for tracing
    const requestId = crypto.randomUUID();
    
    try {
      const response = await handleRequest(request, env);
      
      // Add request ID to response headers
      response.headers.set('X-Request-ID', requestId);
      
      return response;
    } catch (error) {
      console.error('Unhandled error:', error);
      
      const errorResponse = ApiResponse.error('Internal server error', 500);
      errorResponse.headers.set('X-Request-ID', requestId);
      
      return errorResponse;
    }
  }
};