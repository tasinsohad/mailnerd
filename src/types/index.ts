export interface PlanConfig {
  minSubdomains: number
  maxSubdomains: number
  minInboxes: number
  maxInboxes: number
}

export interface MailboxPlan {
  username: string
  displayName: string
  isGeneric: boolean
}

export interface SubdomainPlan {
  prefix: string
  suffix: string
  fullSubdomain: string
  inboxCount: number
  mailboxes: MailboxPlan[]
}

export interface Plan {
  rootDomain: string
  subdomainCount: number
  subdomains: SubdomainPlan[]
  totalMailboxes: number
}

export interface VPSNode {
  id: string
  provisioning_source: 'contabo' | 'manual'
  contabo_instance_id: string | null
  contabo_product_id: string | null
  hostname: string
  main_ip: string
  ssh_port: number
  ssh_username: string
  ssh_private_key_encrypted: string | null
  ssh_password_encrypted: string | null
  ssh_public_key: string | null
  mailcow_installed: boolean
  mailcow_api_key_encrypted: string | null
  mailcow_api_endpoint: string | null
  max_domains_per_node: number
  current_domain_count: number
  status: 'pending' | 'provisioning' | 'installing_mailcow' | 'active' | 'failed' | 'deprovisioned'
  location: string | null
  provider_label: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface IPPool {
  id: string
  vps_id: string
  ip_address: string
  is_primary: boolean
  created_at: string
}

export interface ProvisioningJob {
  id: string
  root_domain: string
  status: 'pending' | 'planning' | 'provisioning_vps' | 'installing_mailcow' | 'configuring_dns' | 'creating_mailboxes' | 'completed' | 'failed' | 'cancelled'
  progress: number
  total_subdomains: number | null
  total_mailboxes: number | null
  inngest_run_id: string | null
  result_encrypted: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface SubdomainPlanRecord {
  id: string
  job_id: string
  vps_id: string | null
  prefix: string
  suffix: string
  full_subdomain: string
  assigned_ip: string | null
  dkim_selector: string | null
  dkim_public_key: string | null
  postfix_config_applied: boolean
  status: 'pending' | 'vps_assigned' | 'dns_configured' | 'mailcow_domain_added' | 'dkim_configured' | 'postfix_bound' | 'mailboxes_created' | 'failed'
  error_message: string | null
  created_at: string
}

export interface Mailbox {
  id: string
  subdomain_id: string
  email: string
  password_encrypted: string
  first_name: string | null
  last_name: string | null
  status: 'created' | 'failed'
  created_at: string
}

export interface ContaboInstance {
  instanceId: string
  name: string
  status: 'provisioning' | 'running' | 'stopped'
  ipAddress: string
  productId: string
  region: string
  imageId: string
  createdDate: string
}

export interface ContaboSecret {
  secretId: string
  name: string
  type: 'ssh' | 'password'
}

export interface ManualVPSInput {
  ip: string
  sshUsername?: string
  sshPort?: number
  label?: string
  location?: string
  notes?: string
  sshPrivateKey?: string
  sshPassword?: string
  mailcowAlreadyInstalled?: boolean
  mailcowApiKey?: string
  mailcowApiPort?: number
  maxDomainsPerNode?: number
}

export interface VPSRegistrationResult {
  vpsId: string
}

export interface CloudflareRecord {
  id: string
  type: string
  name: string
  content: string
  ttl: number
  proxied: boolean
}

export type CloudflareDNSType = 'A' | 'MX' | 'TXT' | 'CNAME'

export interface MailcowDomain {
  domain: string
  active: number
}

export interface DKIMResult {
  selector: string
  publicKey: string
}

export interface MailcowMailboxParams {
  domain: string
  username: string
  password: string
  quotaMb?: number
  name?: string
}

export interface MailcowHealthStatus {
  healthy: boolean
  containers: Record<string, unknown>
}

export type SSHAuth =
  | { type: 'key'; privateKey: string }
  | { type: 'password'; password: string }

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ProvisionResponse {
  jobId: string
  status: string
  totalSubdomains: number
  totalMailboxes: number
  estimatedMinutes: number
}

export interface SubdomainStatus {
  fullSubdomain: string
  status: string
  mailboxCount: number
  errorMessage?: string
}

export interface JobStatusResponse {
  jobId: string
  status: string
  progress: number
  completedAt?: string
  subdomains: SubdomainStatus[]
  credentials?: Array<{
    subdomain: string
    assignedIp: string
    mailboxes: Array<{ email: string; password: string }>
  }>
  errorMessage?: string
}

export interface VPSNodeSummary {
  vpsId: string
  hostname: string
  ip: string
  status: string
  provisioningSource: string
  label: string | null
  location: string | null
  mailcowInstalled: boolean
  currentDomainCount: number
  maxDomainsPerNode: number
  capacityPercent: number
  createdAt: string
}

export interface VPSListResponse {
  nodes: VPSNodeSummary[]
  summary: {
    total: number
    active: number
    provisioning: number
    failed: number
    totalCapacity: number
    usedCapacity: number
  }
}

export interface VPSRegisterResponse {
  vpsId: string
  status: string
  port25Open: boolean
  port25Warning?: string
  mailcowEndpoint?: string
  message: string
}

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptionError'
  }
}

export class SSHConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSHConnectionError'
  }
}

export class SSHCommandError extends Error {
  public stdout: string
  public stderr: string
  public exitCode: number

  constructor(message: string, result: CommandResult) {
    super(message)
    this.name = 'SSHCommandError'
    this.stdout = result.stdout
    this.stderr = result.stderr
    this.exitCode = result.exitCode
  }
}

export class SSHTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSHTimeoutError'
  }
}

export class ContaboAPIError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContaboAPIError'
  }
}

export class ContaboTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContaboTimeoutError'
  }
}

export class ContaboAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContaboAuthError'
  }
}

export class CloudflareAPIError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudflareAPIError'
  }
}

export class CloudflareRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudflareRateLimitError'
  }
}

export class MailcowAPIError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailcowAPIError'
  }
}

export class DKIMTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DKIMTimeoutError'
  }
}

export class MailcowDeployError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailcowDeployError'
  }
}

export class UnauthorizedError extends Error {
  constructor(message: string = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}
