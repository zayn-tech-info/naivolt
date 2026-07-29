/**
 * Deposit — step 3: the address.
 *
 * The screen where a mistake is unrecoverable. Sending USDT to a TRC-20 address
 * over BEP-20 destroys the funds and no amount of support can undo it, so the
 * layout is built around making the network unmissable rather than around
 * showing the address quickly.
 *
 * The warning sits above the QR deliberately. Reading order is the point: you
 * cannot reach the address without passing the network it belongs to. And the
 * warning names that network in the same mono face as the address — a generic
 * "make sure you use the right network" is advice, "this address only accepts
 * TRC-20" is an instruction.
 */

import { View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '@/design';
import {
  Button,
  CopyField,
  Screen,
  Skeleton,
  Stagger,
  Surface,
  Text,
} from '@/components/ui';
import ScreenHeader from '@/components/navigation/ScreenHeader';
import { useDepositAddress } from '@/hooks/useExchange';
import { CHAINS_FOR_ASSET, parseAsset, parseChainFor } from '@/constants/assets';

export default function DepositAddressScreen() {
  const router = useRouter();
  const { c, space, radius } = useTheme();
  const params = useLocalSearchParams<{ asset: string; chain: string }>();

  const asset = parseAsset(params.asset);
  const chain = asset ? parseChainFor(asset, params.chain) : null;

  const ready = !!asset && !!chain;
  const { data: deposit, isLoading } = useDepositAddress(asset!, chain!, ready);

  // An asset/network pair the backend can't derive an address for must never
  // render a half-built screen — send them back to pick again.
  if (!asset) return <Redirect href="/deposit" />;
  if (!chain) return <Redirect href={{ pathname: '/deposit/[asset]', params: { asset } }} />;

  const meta = (CHAINS_FOR_ASSET[asset] ?? []).find((x) => x.chain === chain);
  const networkLabel = deposit?.network ?? meta?.network ?? chain;

  return (
    <Screen edges={['top']}>
      <ScreenHeader title={`${asset} · ${networkLabel}`} onBack={() => router.back()} />

      <Stagger index={0}>
        <Surface
          level={1}
          accentEdge={c.warning}
          style={{ marginTop: space.base, flexDirection: 'row', gap: space.base }}
        >
          <Ionicons name="warning-outline" size={19} color={c.warning} />
          <View style={{ flex: 1, gap: 3 }}>
            <Text variant="subheading" color="warning">
              {networkLabel} only
            </Text>
            <Text variant="bodySmall" color="secondaryText">
              This address accepts {asset} on {networkLabel}. Sending on any other network loses
              the funds permanently.
            </Text>
          </View>
        </Surface>
      </Stagger>

      {isLoading || !deposit ? (
        <Surface
          level={1}
          style={{ marginTop: space.base, alignItems: 'center', gap: space.comfy }}
        >
          <Skeleton width={168} height={168} radius={radius.tile} />
          <Skeleton width="100%" height={52} radius={radius.field} />
        </Surface>
      ) : (
        <>
          <Stagger index={1}>
            <Surface
              level={1}
              style={{ marginTop: space.base, alignItems: 'center', gap: space.roomy }}
            >
              {/* QR on a permanent white plate — inverting a QR for dark mode
                  breaks scanners that expect dark-on-light. */}
              <View
                style={{ backgroundColor: '#FFFFFF', padding: 14, borderRadius: radius.tile }}
              >
                <QRCode
                  value={deposit.address}
                  size={168}
                  backgroundColor="#FFFFFF"
                  color="#000000"
                />
              </View>

              <View style={{ width: '100%' }}>
                <CopyField
                  value={deposit.address}
                  label={`${asset} · ${networkLabel} address`}
                  groupSize={4}
                />
              </View>
            </Surface>
          </Stagger>

          <Stagger index={2}>
            <Surface
              level={1}
              padding={0}
              style={{ marginTop: space.base, paddingHorizontal: space.comfy }}
            >
              <Fact label="Minimum deposit" value={`${deposit.minimumDeposit} ${asset}`} />
              <Fact
                label="Credited after"
                value={`${deposit.minConfirmations} confirmation${
                  deposit.minConfirmations === 1 ? '' : 's'
                }`}
              />
              <Fact label="Deposit fee" value="Free" last />
            </Surface>
          </Stagger>

          <Stagger index={3}>
            <Text
              variant="caption"
              color="tertiaryText"
              align="center"
              style={{ marginTop: space.comfy }}
            >
              This address is permanently yours. You can reuse it for every {asset} deposit on{' '}
              {networkLabel}.
            </Text>
          </Stagger>

          <Button
            title="Done"
            variant="secondary"
            onPress={() => router.dismissTo('/(tabs)/(main)')}
            fullWidth
            style={{ marginTop: space.roomy }}
          />
        </>
      )}
    </Screen>
  );
}

/** A label/value line in the facts block. */
function Fact({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  const { c, space } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: space.base,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <Text variant="bodySmall" color="secondaryText">
        {label}
      </Text>
      <Text variant="amountSmall">{value}</Text>
    </View>
  );
}
