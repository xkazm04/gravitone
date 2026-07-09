# AWS setup — one-time, then hands-off benchmarking

Goal: let the agent launch a Graviton box, run the benchmark over **SSM (no
SSH keys, no inbound ports)**, fetch results, and stop/terminate it — while you
only pay for the minutes it actually runs.

## What you do once (needs an admin/owner AWS login)

```bash
# 0. Install AWS CLI v2 and log in as an admin for these setup steps.

# 1. SSM instance role + profile (lets the EC2 box be driven via SSM).
aws iam create-role --role-name gravitone-ssm-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name gravitone-ssm-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name gravitone-ssm-profile
aws iam add-role-to-instance-profile \
  --instance-profile-name gravitone-ssm-profile --role-name gravitone-ssm-role

# 2. A restricted IAM user the agent will use (policy = aws/iam-policy.json).
aws iam create-user --user-name gravitone-agent
aws iam put-user-policy --user-name gravitone-agent \
  --policy-name gravitone-agent-policy --policy-document file://aws/iam-policy.json
aws iam create-access-key --user-name gravitone-agent   # <-- copy AccessKeyId + SecretAccessKey

# 3. Configure that user as a named profile on the machine the agent runs on.
aws configure --profile gravitone   # paste key/secret; region e.g. us-east-1; output json
```

Optional safety net (recommended): a zero-spend budget alert, and/or a billing
alarm, so a forgotten running instance can't surprise you.

## What the agent does (autonomous, via `aws/run_benchmark.sh`)

```bash
PROFILE=gravitone REGION=us-east-1 TYPE=c8g.2xlarge aws/run_benchmark.sh up        # launch + wait for SSM
PROFILE=gravitone REGION=us-east-1               aws/run_benchmark.sh bench      # clone repo, run benchmark_arm.sh, print results
PROFILE=gravitone REGION=us-east-1               aws/run_benchmark.sh stop        # stop (≈$0 compute, keeps disk)
# ...iterate: bench again after tweaks...
PROFILE=gravitone REGION=us-east-1               aws/run_benchmark.sh terminate   # delete entirely when done
```

Everything is tagged `Name=gravitone-bench`. Nothing else in your account is
touched. Cost: `c8g.2xlarge` ≈ $0.29/hr while running; **stop** drops compute to
$0 (only ~$0.64/mo for the 20 GB disk). A full benchmark run is ~15-25 min.

## Blast radius / what these permissions allow

The `gravitone-agent` policy (`aws/iam-policy.json`) can only: run/start/stop/
terminate/describe **EC2 instances**, create a security group + tags, read
public SSM AMI parameters, drive instances via **SSM**, and **PassRole** the
`gravitone-ssm-*` profile onto instances. It cannot touch IAM users/policies,
S3, billing, or anything else. Tighten `PassRole`'s `Resource` to the role ARN
if you want it stricter.
