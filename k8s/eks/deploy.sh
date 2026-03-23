#!/bin/bash
# Deploy License Server to EKS
# Usage: ./deploy.sh [build|deploy|all]

set -e

# Configuration
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-772693061584}"
ECR_REPO="ag-license-server"
IMAGE_TAG="${IMAGE_TAG:-latest}"
NAMESPACE="preprod"

ECR_URL="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
FULL_IMAGE="${ECR_URL}/${ECR_REPO}:${IMAGE_TAG}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"

build_image() {
    log_info "Building Docker image..."

    cd "$PROJECT_ROOT"

    # Login to ECR
    log_info "Logging in to ECR..."
    aws ecr get-login-password --region "$AWS_REGION" | \
        docker login --username AWS --password-stdin "$ECR_URL"

    # Build image
    log_info "Building image: $FULL_IMAGE"
    docker build -f Dockerfile.eks -t "$FULL_IMAGE" .

    # Push to ECR
    log_info "Pushing image to ECR..."
    docker push "$FULL_IMAGE"

    log_info "Image pushed successfully: $FULL_IMAGE"
}

deploy_k8s() {
    log_info "Deploying to Kubernetes..."

    cd "$SCRIPT_DIR"

    # Verify kubectl context
    CURRENT_CONTEXT=$(kubectl config current-context)
    log_info "Current kubectl context: $CURRENT_CONTEXT"
    read -p "Continue with this context? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_error "Deployment cancelled"
        exit 1
    fi

    # Apply with kustomize
    log_info "Applying Kubernetes manifests..."
    kubectl apply -k .

    # Wait for rollout
    log_info "Waiting for deployment rollout..."
    kubectl rollout status deployment/license-server -n "$NAMESPACE" --timeout=300s

    # Show status
    log_info "Deployment status:"
    kubectl get pods -n "$NAMESPACE" -l app=license-server

    log_info "Deployment complete!"
}

show_status() {
    log_info "License Server Status"
    echo "====================="

    echo ""
    echo "Pods:"
    kubectl get pods -n "$NAMESPACE" -l app=license-server -o wide

    echo ""
    echo "Service:"
    kubectl get svc -n "$NAMESPACE" license-server

    echo ""
    echo "HPA:"
    kubectl get hpa -n "$NAMESPACE" license-server-hpa

    echo ""
    echo "Recent logs:"
    kubectl logs -n "$NAMESPACE" -l app=license-server --tail=20
}

terraform_apply() {
    log_info "Applying Terraform..."

    cd "$PROJECT_ROOT/terraform/eks"

    terraform init
    terraform plan -out=tfplan

    read -p "Apply this plan? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        terraform apply tfplan
    fi
}

# Main
case "${1:-all}" in
    build)
        build_image
        ;;
    deploy)
        deploy_k8s
        ;;
    status)
        show_status
        ;;
    terraform)
        terraform_apply
        ;;
    all)
        build_image
        deploy_k8s
        show_status
        ;;
    *)
        echo "Usage: $0 [build|deploy|status|terraform|all]"
        echo ""
        echo "Commands:"
        echo "  build     - Build and push Docker image to ECR"
        echo "  deploy    - Deploy to Kubernetes using kustomize"
        echo "  status    - Show deployment status"
        echo "  terraform - Apply Terraform configuration"
        echo "  all       - Build, deploy, and show status"
        exit 1
        ;;
esac
