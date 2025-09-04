#!/bin/bash

# VoiceCert DNS Management Script
# This script provides AWS CLI commands to manage Route53 DNS records
# Only needed for oracle mail server setup if you want outlook or gmail integration via imap and smtp
# Not needed for webmail setup

set -e

# Configuration
HOSTED_ZONE_ID="Z1234567890ABC"  # Replace with your hosted zone ID
DOMAIN="yourdomain.com"
API_GATEWAY_DOMAIN="voicecert-prod.execute-api.us-east-1.amazonaws.com"  # Replace with your actual API Gateway domain

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}"
}

# Function to check if AWS CLI is installed
check_aws_cli() {
    if ! command -v aws &> /dev/null; then
        print_error "AWS CLI is not installed. Please install it first."
        exit 1
    fi
}

# Function to check AWS credentials
check_aws_credentials() {
    if ! aws sts get-caller-identity &> /dev/null; then
        print_error "AWS credentials not configured. Please run 'aws configure' first."
        exit 1
    fi
}

# Function to get current DNS records
list_current_records() {
    print_header "Current DNS Records"
    
    aws route53 list-resource-record-sets \
        --hosted-zone-id "$HOSTED_ZONE_ID" \
        --query 'ResourceRecordSets[?Type==`CNAME` || Type==`SRV`]' \
        --output table
}

# Function to create DNS records
create_dns_records() {
    print_header "Creating DNS Records"
    
    # Create change batch file
    cat > /tmp/dns-changes.json << EOF
{
    "Changes": [
        {
            "Action": "CREATE",
            "ResourceRecordSet": {
                "Name": "imap.$DOMAIN",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "$API_GATEWAY_DOMAIN"
                    }
                ]
            }
        },
        {
            "Action": "CREATE",
            "ResourceRecordSet": {
                "Name": "smtp.$DOMAIN",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "$API_GATEWAY_DOMAIN"
                    }
                ]
            }
        },
        {
            "Action": "CREATE",
            "ResourceRecordSet": {
                "Name": "autodiscover.$DOMAIN",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "$API_GATEWAY_DOMAIN"
                    }
                ]
            }
        },
        {
            "Action": "CREATE",
            "ResourceRecordSet": {
                "Name": "_autodiscover._tcp.$DOMAIN",
                "Type": "SRV",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "0 0 443 autodiscover.$DOMAIN"
                    }
                ]
            }
        }
    ]
}
EOF
    
    print_status "Submitting DNS changes..."
    
    CHANGE_ID=$(aws route53 change-resource-record-sets \
        --hosted-zone-id "$HOSTED_ZONE_ID" \
        --change-batch file:///tmp/dns-changes.json \
        --query 'ChangeInfo.Id' \
        --output text)
    
    print_status "Change submitted with ID: $CHANGE_ID"
    
    # Wait for changes to propagate
    print_status "Waiting for DNS changes to propagate..."
    aws route53 wait resource-record-sets-changed --id "$CHANGE_ID"
    
    print_status "DNS changes have propagated successfully!"
    
    # Clean up
    rm -f /tmp/dns-changes.json
}

# Function to update DNS records
update_dns_records() {
    print_header "Updating DNS Records"
    
    # Create change batch file for updates
    cat > /tmp/dns-updates.json << EOF
{
    "Changes": [
        {
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": "imap.$DOMAIN",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "$API_GATEWAY_DOMAIN"
                    }
                ]
            }
        },
        {
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": "smtp.$DOMAIN",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "$API_GATEWAY_DOMAIN"
                    }
                ]
            }
        },
        {
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": "autodiscover.$DOMAIN",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "$API_GATEWAY_DOMAIN"
                    }
                ]
            }
        },
        {
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": "_autodiscover._tcp.$DOMAIN",
                "Type": "SRV",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "0 0 443 autodiscover.$DOMAIN"
                    }
                ]
            }
        }
    ]
}
EOF
    
    print_status "Submitting DNS updates..."
    
    CHANGE_ID=$(aws route53 change-resource-record-sets \
        --hosted-zone-id "$HOSTED_ZONE_ID" \
        --change-batch file:///tmp/dns-updates.json \
        --query 'ChangeInfo.Id' \
        --output text)
    
    print_status "Update submitted with ID: $CHANGE_ID"
    
    # Wait for changes to propagate
    print_status "Waiting for DNS updates to propagate..."
    aws route53 wait resource-record-sets-changed --id "$CHANGE_ID"
    
    print_status "DNS updates have propagated successfully!"
    
    # Clean up
    rm -f /tmp/dns-updates.json
}

# Function to delete DNS records
delete_dns_records() {
    print_header "Deleting DNS Records"
    
    print_warning "This will delete all email-related DNS records!"
    read -p "Are you sure you want to continue? (y/N): " -n 1 -r
    echo
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_status "Deletion cancelled."
        exit 0
    fi
    
    # Create change batch file for deletions
    cat > /tmp/dns-deletes.json << EOF
{
    "Changes": [
        {
            "Action": "DELETE",
            "ResourceRecordSet": {
                "Name": "imap.$DOMAIN",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "$API_GATEWAY_DOMAIN"
                    }
                ]
            }
        },
        {
            "Action": "DELETE",
            "ResourceRecordSet": {
                "Name": "smtp.$DOMAIN",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "$API_GATEWAY_DOMAIN"
                    }
                ]
            }
        },
        {
            "Action": "DELETE",
            "ResourceRecordSet": {
                "Name": "autodiscover.$DOMAIN",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "$API_GATEWAY_DOMAIN"
                    }
                ]
            }
        },
        {
            "Action": "DELETE",
            "ResourceRecordSet": {
                "Name": "_autodiscover._tcp.$DOMAIN",
                "Type": "SRV",
                "TTL": 300,
                "ResourceRecords": [
                    {
                        "Value": "0 0 443 autodiscover.$DOMAIN"
                    }
                ]
            }
        }
    ]
}
EOF
    
    print_status "Submitting DNS deletions..."
    
    CHANGE_ID=$(aws route53 change-resource-record-sets \
        --hosted-zone-id "$HOSTED_ZONE_ID" \
        --change-batch file:///tmp/dns-deletes.json \
        --query 'ChangeInfo.Id' \
        --output text)
    
    print_status "Deletion submitted with ID: $CHANGE_ID"
    
    # Wait for changes to propagate
    print_status "Waiting for DNS deletions to propagate..."
    aws route53 wait resource-record-sets-changed --id "$CHANGE_ID"
    
    print_status "DNS records have been deleted successfully!"
    
    # Clean up
    rm -f /tmp/dns-deletes.json
}

# Function to test DNS resolution
test_dns_resolution() {
    print_header "Testing DNS Resolution"
    
    local records=("imap.$DOMAIN" "smtp.$DOMAIN" "autodiscover.$DOMAIN")
    
    for record in "${records[@]}"; do
        print_status "Testing $record..."
        if nslookup "$record" &> /dev/null; then
            print_status "✅ $record resolves successfully"
        else
            print_error "❌ $record failed to resolve"
        fi
    done
    
    # Test SRV record
    print_status "Testing SRV record _autodiscover._tcp.$DOMAIN..."
    if dig SRV "_autodiscover._tcp.$DOMAIN" +short &> /dev/null; then
        print_status "✅ SRV record resolves successfully"
    else
        print_error "❌ SRV record failed to resolve"
    fi
}

# Function to show usage
show_usage() {
    echo "VoiceCert DNS Management Script"
    echo ""
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  list      - List current DNS records"
    echo "  create    - Create DNS records for email services"
    echo "  update    - Update existing DNS records"
    echo "  delete    - Delete DNS records (with confirmation)"
    echo "  test      - Test DNS resolution"
    echo "  help      - Show this help message"
    echo ""
    echo "Configuration:"
    echo "  HOSTED_ZONE_ID: $HOSTED_ZONE_ID"
    echo "  DOMAIN: $DOMAIN"
    echo "  API_GATEWAY_DOMAIN: $API_GATEWAY_DOMAIN"
    echo ""
    echo "Make sure to update the configuration variables at the top of this script!"
}

# Main script logic
main() {
    # Check prerequisites
    check_aws_cli
    check_aws_credentials
    
    # Parse command
    case "${1:-help}" in
        list)
            list_current_records
            ;;
        create)
            create_dns_records
            ;;
        update)
            update_dns_records
            ;;
        delete)
            delete_dns_records
            ;;
        test)
            test_dns_resolution
            ;;
        help|--help|-h)
            show_usage
            ;;
        *)
            print_error "Unknown command: $1"
            show_usage
            exit 1
            ;;
    esac
}

# Run main function
main "$@"
