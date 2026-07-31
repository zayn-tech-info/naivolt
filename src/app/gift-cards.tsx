/**
 * Gift cards — sell a card for naira.
 *
 * Now runs through the v2 service adapter like every other surface. It was the
 * last screen calling the v1 Express API directly, which stopped existing when
 * that backend was removed (commit 85bafc4) — so it was also the only screen
 * that broke.
 *
 * Three steps: pick a brand, pick the country, enter the card. Country is its own
 * decision rather than a dropdown buried in the form, because the same brand
 * clears at very different rates by country — Amazon UK pays meaningfully more
 * than Amazon Canada — and that difference is the main thing a seller is choosing
 * between.
 *
 * The payout figure updates live as the face value is typed, before anything is
 * submitted. This is a manual-review flow: an admin verifies the card and only
 * then is naira credited. So the one thing a user must be able to check up front
 * is what they'll actually get, and making them submit to find out is how a flow
 * gets abandoned.
 */

import { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  Button,
  EmptyState,
  Input,
  Money,
  Screen,
  Section,
  Skeleton,
  Stagger,
  Surface,
  Text,
  useToast,
} from '@/components/ui';
import ScreenHeader from '@/components/navigation/ScreenHeader';
import { useGiftCardBrands, useSubmitGiftCard } from '@/hooks/useExchange';
import type { GiftCardBrand, GiftCardRate, GiftCardSubmission } from '@/services/v2/types';

/** Common face values, so the usual case is one tap. */
const QUICK_VALUES = [25, 50, 100, 200];

/** Deterministic tint per brand, for the logo plate and lettermark fallback. */
function brandTint(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${hash}, 58%, 52%)`;
}

export default function GiftCardsScreen() {
  const router = useRouter();
  const { c, space, radius } = useTheme();
  const { show } = useToast();

  const brands = useGiftCardBrands();
  const submitCard = useSubmitGiftCard();

  const [brand, setBrand] = useState<GiftCardBrand | null>(null);
  const [rate, setRate] = useState<GiftCardRate | null>(null);
  const [faceValue, setFaceValue] = useState('');
  const [cardCode, setCardCode] = useState('');
  const [cardPin, setCardPin] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<GiftCardSubmission | null>(null);
  const [error, setError] = useState('');
  // Minted once per card, so a retry after an ambiguous failure can't create a
  // second submission for the same physical card.
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const value = Number(faceValue) || 0;
  const payout = rate && value > 0 ? value * Number(rate.ratePerUnit) : 0;

  const selectBrand = useCallback((next: GiftCardBrand) => {
    setBrand(next);
    // One country means no choice to present.
    setRate(next.rates.length === 1 ? next.rates[0] : null);
    setFaceValue('');
    setCardCode('');
    setCardPin('');
    setImageUri(null);
    setError('');
    setIdempotencyKey(Crypto.randomUUID());
  }, []);

  const goBack = useCallback(() => {
    if (brand) {
      setBrand(null);
      setRate(null);
      setError('');
    } else {
      router.back();
    }
  }, [brand, router]);

  const pickImage = useCallback(async () => {
    try {
      const ImagePicker = await import('expo-image-picker');
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        show('Allow photo access to upload the card', 'warning');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) setImageUri(result.assets[0].uri);
    } catch {
      show('Could not open your photo library', 'negative');
    }
  }, [show]);

  const canSubmit =
    !!brand &&
    !!rate &&
    value > 0 &&
    cardCode.trim().length > 0 &&
    (!brand.requiresImage || !!imageUri) &&
    !!idempotencyKey;

  const submit = useCallback(async () => {
    if (!canSubmit || !brand || !rate || !idempotencyKey) return;
    setError('');
    try {
      const result = await submitCard.mutateAsync({
        brandId: brand.id,
        countryCode: rate.countryCode,
        faceValue: String(value),
        cardCode: cardCode.trim(),
        cardPin: cardPin.trim() || undefined,
        imageUri: imageUri ?? undefined,
        idempotencyKey,
      });
      setSubmitted(result);
    } catch (err) {
      setError((err as { message?: string })?.message ?? 'Could not submit the card.');
    }
  }, [canSubmit, brand, rate, value, cardCode, cardPin, imageUri, idempotencyKey, submitCard]);

  // ── Submitted ───────────────────────────────────────────────────────
  if (submitted) {
    return (
      <Screen edges={['top']} scroll={false}>
        <ScreenHeader />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.comfy }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: c.warningDim,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="hourglass-outline" size={28} color={c.warning} />
          </View>

          <Text variant="title" align="center">
            Card submitted
          </Text>
          <Money value={Number(submitted.payoutNgn)} variant="figure" />

          <Text variant="bodySmall" color="secondaryText" align="center" style={{ maxWidth: 300 }}>
            We’re checking your {submitted.brandName} card. Naira is credited once it clears —
            usually within an hour. You’ll get a notification either way.
          </Text>

          <Surface level={1} radiusToken="field" style={{ marginTop: space.snug }}>
            <Text variant="code" color="tertiaryText">
              {submitted.reference}
            </Text>
          </Surface>

          <Button
            title="Done"
            onPress={() => router.back()}
            size="lg"
            style={{ marginTop: space.comfy, minWidth: 200 }}
          />
        </View>
      </Screen>
    );
  }

  // ── Step 1: pick a brand ────────────────────────────────────────────
  if (!brand) {
    const list = brands.data ?? [];
    return (
      <Screen edges={['top']} tabBarClearance>
        <ScreenHeader title="Sell a gift card" onBack={goBack} />

        {brands.isLoading ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.base }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} width="47.5%" height={120} radius={radius.tile} />
            ))}
          </View>
        ) : brands.isError ? (
          <View style={{ marginTop: space.major }}>
            <EmptyState
              icon="cloud-offline-outline"
              title="Couldn’t load card types"
              body="Check your connection and try again."
              actionLabel="Retry"
              onAction={() => brands.refetch()}
            />
          </View>
        ) : list.length === 0 ? (
          <View style={{ marginTop: space.major }}>
            <EmptyState
              icon="gift-outline"
              title="No cards accepted right now"
              body="Card types are set by Naivolt. Check back shortly."
            />
          </View>
        ) : (
          <>
            <Text variant="bodySmall" color="tertiaryText" style={{ marginBottom: space.comfy }}>
              Pick your card. Rates are per unit of face value and vary by country.
            </Text>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.base }}>
              {list.map((item, i) => (
                <Stagger key={item.id} index={Math.min(i, 5)} style={{ width: '47.5%' }}>
                  <BrandTile brand={item} onPress={() => selectBrand(item)} />
                </Stagger>
              ))}
            </View>
          </>
        )}
      </Screen>
    );
  }

  // ── Step 2: country + card details ──────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen edges={['top']}>
        <ScreenHeader title={brand.name} onBack={goBack} />

        {/* Payout leads — it's what the user came to find out. */}
        <Stagger index={0}>
          <Surface level={1} style={{ alignItems: 'center', gap: space.tight }}>
            <Text variant="eyebrow" color="tertiaryText">
              You get
            </Text>
            {payout > 0 ? (
              <Money value={payout} variant="figure" whole />
            ) : (
              <Text variant="figure" color="quaternaryText">
                ₦0
              </Text>
            )}
            <Text variant="caption" color="tertiaryText">
              {rate
                ? `₦${Number(rate.ratePerUnit).toLocaleString('en-NG')} per ${rate.currency}`
                : 'Pick a country to see the rate'}
            </Text>
          </Surface>
        </Stagger>

        <Stagger index={1}>
          <Section title="Card country">
            <View style={{ gap: space.snug }}>
              {brand.rates.map((option) => {
                const selected = rate?.countryCode === option.countryCode;
                return (
                  <Surface
                    key={option.countryCode}
                    level={selected ? 2 : 1}
                    radiusToken="tile"
                    padding={space.comfy}
                    onPress={() => setRate(option)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.base,
                      borderWidth: 1,
                      borderColor: selected ? c.primaryAccent : 'transparent',
                    }}
                    accessibilityLabel={`${option.countryName}, ${option.ratePerUnit} naira per ${option.currency}`}
                  >
                    <View style={{ flex: 1 }}>
                      <Text variant="subheading">{option.countryName}</Text>
                      <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
                        {option.currency} · min {option.minFaceValue}
                      </Text>
                    </View>

                    <Money
                      value={Number(option.ratePerUnit)}
                      variant="amount"
                      whole
                      color={selected ? 'primaryText' : 'secondaryText'}
                    />
                  </Surface>
                );
              })}
            </View>
          </Section>
        </Stagger>

        {rate ? (
          <>
            <Stagger index={2}>
              <Section title="Face value">
                <View style={{ flexDirection: 'row', gap: space.snug, marginBottom: space.base }}>
                  {QUICK_VALUES.map((amount) => {
                    const active = value === amount;
                    return (
                      <Surface
                        key={amount}
                        level={active ? 2 : 1}
                        radiusToken="chip"
                        padding={space.snug + 2}
                        onPress={() => setFaceValue(String(amount))}
                        style={{
                          flex: 1,
                          alignItems: 'center',
                          borderWidth: 1,
                          borderColor: active ? c.primaryAccent : 'transparent',
                        }}
                      >
                        <Text variant="amount" color={active ? 'primaryText' : 'secondaryText'}>
                          {amount}
                        </Text>
                      </Surface>
                    );
                  })}
                </View>

                <Input
                  value={faceValue}
                  onChangeText={setFaceValue}
                  placeholder="Or type the amount on the card"
                  keyboardType="decimal-pad"
                  mono
                  prefix={rate.currency}
                  hint={`Between ${rate.minFaceValue} and ${rate.maxFaceValue} ${rate.currency}`}
                />
              </Section>
            </Stagger>

            <Stagger index={3}>
              <Section title="Card details">
                <Input
                  label="Card code"
                  value={cardCode}
                  onChangeText={setCardCode}
                  placeholder="XXXX-XXXX-XXXX"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  mono
                />
                {brand.hasPin ? (
                  <Input
                    label="PIN"
                    value={cardPin}
                    onChangeText={setCardPin}
                    placeholder="On the back of the card"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    mono
                  />
                ) : null}
              </Section>
            </Stagger>

            {brand.requiresImage ? (
              <Stagger index={4}>
                <Section title="Card photo">
                  {imageUri ? (
                    <Surface level={1} style={{ gap: space.base }}>
                      <Image
                        source={{ uri: imageUri }}
                        style={{ width: '100%', height: 180, borderRadius: radius.tile }}
                        contentFit="cover"
                      />
                      <View style={{ flexDirection: 'row', gap: space.snug }}>
                        <Button title="Replace" variant="secondary" size="sm" onPress={pickImage} />
                        <Button
                          title="Remove"
                          variant="ghost"
                          size="sm"
                          onPress={() => setImageUri(null)}
                        />
                      </View>
                    </Surface>
                  ) : (
                    <Surface
                      level={1}
                      onPress={pickImage}
                      style={{
                        alignItems: 'center',
                        gap: space.snug,
                        paddingVertical: space.section,
                        borderWidth: 1,
                        borderColor: c.border,
                        borderStyle: 'dashed',
                      }}
                    >
                      <Ionicons name="camera-outline" size={24} color={c.tertiaryText} />
                      <Text variant="subheading">Add a photo of the card</Text>
                      <Text
                        variant="caption"
                        color="tertiaryText"
                        align="center"
                        style={{ maxWidth: 250 }}
                      >
                        Clear enough to read the code. This is what our team checks against.
                      </Text>
                    </Surface>
                  )}
                </Section>
              </Stagger>
            ) : null}

            {brand.note ? (
              <Surface
                level={1}
                accentEdge={c.warning}
                style={{ marginTop: space.comfy, flexDirection: 'row', gap: space.snug }}
              >
                <Ionicons name="information-circle-outline" size={17} color={c.warning} />
                <Text variant="bodySmall" color="secondaryText" style={{ flex: 1 }}>
                  {brand.note}
                </Text>
              </Surface>
            ) : null}

            {error ? (
              <Surface
                level={1}
                accentEdge={c.negative}
                style={{ marginTop: space.comfy, flexDirection: 'row', gap: space.snug }}
              >
                <Ionicons name="alert-circle" size={17} color={c.negative} />
                <Text variant="bodySmall" color="negative" style={{ flex: 1 }}>
                  {error}
                </Text>
              </Surface>
            ) : null}

            <Button
              title={payout > 0 ? `Sell for ₦${Math.round(payout).toLocaleString('en-NG')}` : 'Sell card'}
              onPress={submit}
              disabled={!canSubmit}
              loading={submitCard.isPending}
              haptic="medium"
              size="lg"
              fullWidth
              style={{ marginTop: space.roomy }}
            />

            <Text
              variant="caption"
              color="tertiaryText"
              align="center"
              style={{ marginTop: space.base }}
            >
              Cards are checked by our team before payout — usually within an hour.
            </Text>
          </>
        ) : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}

/** One brand in the selection grid. Logo-led, since that's how people scan. */
function BrandTile({ brand, onPress }: { brand: GiftCardBrand; onPress: () => void }) {
  const { space, radius } = useTheme();
  const [failed, setFailed] = useState(false);
  const tint = brandTint(brand.name);

  const bestRate = brand.rates.length
    ? Math.max(...brand.rates.map((r) => Number(r.ratePerUnit)))
    : 0;

  return (
    <Surface
      level={1}
      radiusToken="tile"
      onPress={onPress}
      padding={space.comfy}
      style={{ gap: space.snug, minHeight: 120 }}
      accessibilityLabel={`${brand.name}, up to ${bestRate} naira per unit`}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.chip,
          backgroundColor: failed || !brand.logoUrl ? `${tint}22` : '#FFFFFF',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {brand.logoUrl && !failed ? (
          <Image
            source={{ uri: brand.logoUrl }}
            style={{ width: 40, height: 40 }}
            contentFit="contain"
            transition={120}
            onError={() => setFailed(true)}
          />
        ) : (
          <Text variant="subheading" color={tint} style={{ fontSize: 17 }}>
            {brand.name.slice(0, 1).toUpperCase()}
          </Text>
        )}
      </View>

      <Text variant="subheading" numberOfLines={1}>
        {brand.name}
      </Text>

      {bestRate > 0 ? (
        <Text variant="amountSmall" color="tertiaryText">
          up to ₦{bestRate.toLocaleString('en-NG')}
        </Text>
      ) : (
        <Text variant="caption" color="quaternaryText">
          Rate on request
        </Text>
      )}
    </Surface>
  );
}
