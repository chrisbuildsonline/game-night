#!/usr/bin/env bash
# Run in AWS CloudShell (or any shell with root/admin AWS creds), region us-east-1.
# The Bedrock API key user cannot accept marketplace agreements or the Anthropic use-case form.
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$REGION"

echo "== Anthropic first-time use-case form =="
FORM=$(python3 - <<'PY'
import json, base64
form = {
  "companyName": "ChrisBuilds",
  "companyWebsite": "https://github.com/chrisbuildsonline",
  "intendedUsers": "0",
  "industryOption": "Software and Internet",
  "otherIndustryOption": "",
  "useCases": "Alexa+ hackathon voice game MCP: Bedrock generates murder-mystery cases and judges Twenty Questions answers.",
}
print(base64.b64encode(json.dumps(form).encode()).decode())
PY
)
aws bedrock put-use-case-for-model-access --form-data "$FORM" --region "$REGION" && echo "use-case: ok" || echo "use-case: already set or failed (see above)"

MODELS=(
  anthropic.claude-sonnet-5-5
  anthropic.claude-sonnet-4-6
  anthropic.claude-sonnet-4-5-20250929-v1:0
  anthropic.claude-haiku-4-5-20251001-v1:0
  anthropic.claude-haiku-5-5
)

echo "== Accept marketplace agreements =="
for mid in "${MODELS[@]}"; do
  echo "--- $mid ---"
  TOKEN=$(aws bedrock list-foundation-model-agreement-offers --model-id "$mid" --region "$REGION" --query 'offers[0].offerToken' --output text 2>/dev/null || true)
  if [[ -z "$TOKEN" || "$TOKEN" == "None" ]]; then
    echo "no offer token"
    continue
  fi
  aws bedrock create-foundation-model-agreement --model-id "$mid" --offer-token "$TOKEN" --region "$REGION" && echo "agreement: created" || echo "agreement: may already exist"
  aws bedrock get-foundation-model-availability --model-id "$mid" --region "$REGION" --query '{agreement:agreementAvailability.status,entitlement:entitlementAvailability}' --output json
done

echo
echo "Done. Wait ~15 minutes if agreementAvailability is still PENDING, then:"
echo "  export BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-6   # or anthropic.claude-sonnet-5-5 if AVAILABLE"
echo "  bun run test:live"
echo
echo "If Sonnet 5.5 stays 'not available for this account', use Sonnet 4.6 (same Bedrock path; AWS Builder still counts)."
