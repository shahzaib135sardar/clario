# Infrastructure as code for the Vercel deployment. Written against the Vercel Terraform provider's
# documented resources but NOT run from the authoring environment: run `terraform init && terraform plan`
# and read the plan before applying. Secrets are passed as sensitive variables, never written in this file.
terraform {
  required_version = ">= 1.6"
  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 2.0"
    }
  }
}

provider "vercel" {
  api_token = var.vercel_api_token
  team      = var.vercel_team_id
}

variable "vercel_api_token" {
  type      = string
  sensitive = true
}

variable "vercel_team_id" {
  type    = string
  default = null
}

variable "github_repo" {
  type        = string
  description = "owner/name of the repository Vercel should deploy"
}

variable "public_env" {
  type        = map(string)
  description = "Browser-safe values (VITE_*)"
  default     = {}
}

variable "secret_env" {
  type        = map(string)
  sensitive   = true
  description = "Server-only secrets (GROQ_API_KEY, R2_*, UPSTASH_*, CRON_SECRET, METRICS_TOKEN, ...)"
  default     = {}
}

resource "vercel_project" "clario" {
  name             = "clario"
  framework        = "vite"
  build_command    = "npx vite build"
  output_directory = "dist"
  git_repository = {
    type = "github"
    repo = var.github_repo
  }
}

resource "vercel_project_environment_variable" "public" {
  for_each   = var.public_env
  project_id = vercel_project.clario.id
  key        = each.key
  value      = each.value
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "secret" {
  for_each   = nonsensitive(toset(keys(var.secret_env)))
  project_id = vercel_project.clario.id
  key        = each.value
  value      = var.secret_env[each.value]
  target     = ["production", "preview"]
  sensitive  = true
}
