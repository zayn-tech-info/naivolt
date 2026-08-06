/**
 * Gift cards — sell a card for naira.
 *
 * Three steps: pick a brand, pick the country, enter the card. Brand grid and
 * cards use the sharp system shared with Sell crypto / Profile / Activity.
 */

import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
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
  Text,
  useToast,
} from '@/components/ui';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { BrandMark } from '@/components/giftcards/BrandMark';
import { useGiftCardBrands, useSubmitGiftCard } from '@/hooks/useExchange';
import { useEnsurePush } from '@/hooks/useEnsurePush';
import type { GiftCardBrand, GiftCardRate, GiftCardSubmission } from '@/services/v2/types';


/** Common face values, so the usual case is one tap. */
const QUICK_VALUES = [25, 50, 100, 200];

export default function GiftCardsScreen() {
  const router = useRouter();
  const { c, radius, space, minTouch } = useTheme();
  const { show } = useToast();
  const ensurePush = useEnsurePush();

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
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const value = Number(faceValue) || 0;
  const payout = rate && value > 0 ? value * Number(rate.ratePerUnit) : 0;

  const selectBrand = useCallback((next: GiftCardBrand) => {
    setBrand(next);
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
      // The success screen promises a notification when review completes.
      void ensurePush();
      setSubmitted(result);
    } catch (err) {
      setError((err as { message?: string })?.message ?? 'Could not submit the card.');
    }
  }, [canSubmit, brand, rate, value, cardCode, cardPin, imageUri, idempotencyKey, submitCard, ensurePush]);

  if (submitted) {
    return (
      <Screen edges={['top']} scroll={false}>
        <ScreenHeader />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.comfy }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: radius.card,
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

          <View
            style={{
              marginTop: space.snug,
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: c.hairline,
              backgroundColor: c.surface,
              padding: space.comfy,
            }}
          >
            <Text variant="code" color="tertiaryText">
              {submitted.reference}
            </Text>
          </View>

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

  if (!brand) {
    const list = brands.data ?? [];
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Sell a gift card" onBack={goBack} />

        {brands.isLoading ? (
          <View
            style={{
              marginTop: space.comfy,
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: space.base,
            }}
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} width="47.5%" height={120} radius={radius.card} />
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
            <Text
              variant="bodySmall"
              color="secondaryText"
              style={{ marginTop: space.tight, marginBottom: space.comfy }}
            >
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

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen edges={['top']}>
        <ScreenHeader title={brand.name} onBack={goBack} />

        <Stagger index={0}>
          <View
            style={{
              alignItems: 'center',
              gap: space.tight,
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: c.hairline,
              backgroundColor: c.surface,
              padding: space.comfy,
            }}
          >
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
          </View>
        </Stagger>

        <Stagger index={1}>
          <Section title="Country cards">
            <View
              style={{
                borderRadius: radius.card,
                borderWidth: 1,
                borderColor: c.hairline,
                backgroundColor: c.surface,
                overflow: 'hidden',
              }}
            >
              {brand.rates.map((option, i) => {
                const selected = rate?.countryCode === option.countryCode;
                const last = i === brand.rates.length - 1;
                return (
                  <Pressable
                    key={option.countryCode}
                    onPress={() => setRate(option)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${option.countryName}, ${option.ratePerUnit} naira per ${option.currency}`}
                    style={({ pressed }) => ({
                      minHeight: minTouch + 4,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.comfy,
                      paddingHorizontal: space.comfy,
                      paddingVertical: space.base,
                      backgroundColor: selected
                        ? c.accentDim
                        : pressed
                          ? c.surfaceSunken
                          : 'transparent',
                      ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
                    })}
                  >
                    <CountryFlag code={option.countryCode} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text variant="subheading" numberOfLines={1}>
                        {option.countryName}
                      </Text>
                      <Text variant="caption" color="tertiaryText" numberOfLines={1} style={{ marginTop: 2 }}>
                        {option.currency} · min {option.minFaceValue}
                      </Text>
                    </View>
                    <Money
                      value={Number(option.ratePerUnit)}
                      variant="amount"
                      whole
                      color={selected ? 'primaryText' : 'secondaryText'}
                    />
                    <Ionicons name="chevron-forward" size={16} color={c.quaternaryText} />
                  </Pressable>
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
                      <Pressable
                        key={amount}
                        onPress={() => setFaceValue(String(amount))}
                        style={({ pressed }) => ({
                          flex: 1,
                          alignItems: 'center',
                          paddingVertical: space.base,
                          borderRadius: radius.card,
                          borderWidth: 1,
                          borderColor: active ? c.primaryAccent : c.hairline,
                          backgroundColor: active
                            ? c.accentDim
                            : pressed
                              ? c.surfaceSunken
                              : c.surface,
                        })}
                      >
                        <Text variant="amount" color={active ? 'primaryText' : 'secondaryText'}>
                          {amount}
                        </Text>
                      </Pressable>
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
                  shellRadius={radius.card}
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
                  shellRadius={radius.card}
                />
                {brand.hasPin ? (
                  <Input
                    label="PIN"
                    value={cardPin}
                    onChangeText={setCardPin}
                    placeholder="On the back of the card"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    secureTextEntry
                    mono
                    shellRadius={radius.card}
                  />
                ) : null}
              </Section>
            </Stagger>

            {brand.requiresImage ? (
              <Stagger index={4}>
                <Section title="Card photo">
                  {imageUri ? (
                    <View
                      style={{
                        gap: space.base,
                        borderRadius: radius.card,
                        borderWidth: 1,
                        borderColor: c.hairline,
                        backgroundColor: c.surface,
                        padding: space.comfy,
                      }}
                    >
                      <Image
                        source={{ uri: imageUri }}
                        style={{ width: '100%', height: 180, borderRadius: radius.card }}
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
                    </View>
                  ) : (
                    <Pressable
                      onPress={pickImage}
                      style={({ pressed }) => ({
                        alignItems: 'center',
                        gap: space.snug,
                        paddingVertical: space.section,
                        paddingHorizontal: space.comfy,
                        borderRadius: radius.card,
                        borderWidth: 1,
                        borderColor: c.hairline,
                        borderStyle: 'dashed',
                        backgroundColor: pressed ? c.surfaceSunken : c.surface,
                      })}
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
                    </Pressable>
                  )}
                </Section>
              </Stagger>
            ) : null}

            {brand.note ? (
              <View
                style={{
                  marginTop: space.comfy,
                  flexDirection: 'row',
                  gap: space.snug,
                  padding: space.comfy,
                  borderRadius: radius.card,
                  backgroundColor: c.warningDim,
                  borderWidth: 1,
                  borderColor: c.warning,
                }}
              >
                <Ionicons name="information-circle-outline" size={17} color={c.warning} />
                <Text variant="bodySmall" color="secondaryText" style={{ flex: 1 }}>
                  {brand.note}
                </Text>
              </View>
            ) : null}

            {error ? (
              <View
                style={{
                  marginTop: space.comfy,
                  flexDirection: 'row',
                  gap: space.snug,
                  padding: space.comfy,
                  borderRadius: radius.card,
                  backgroundColor: c.dangerDim,
                  borderWidth: 1,
                  borderColor: c.danger,
                }}
              >
                <Ionicons name="alert-circle" size={17} color={c.danger} />
                <Text variant="bodySmall" color="danger" style={{ flex: 1 }}>
                  {error}
                </Text>
              </View>
            ) : null}

            <Button
              title={
                payout > 0 ? `Sell for ₦${Math.round(payout).toLocaleString('en-NG')}` : 'Sell card'
              }
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

/** One brand in the selection grid. Logo-led, sharp card shell. */
function BrandTile({ brand, onPress }: { brand: GiftCardBrand; onPress: () => void }) {
  const { c, radius, space } = useTheme();

  const bestRate = brand.rates.length
    ? Math.max(...brand.rates.map((r) => Number(r.ratePerUnit)))
    : 0;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${brand.name}, up to ${bestRate} naira per unit`}
      style={({ pressed }) => ({
        gap: space.snug,
        minHeight: 120,
        padding: space.comfy,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: c.hairline,
        backgroundColor: pressed ? c.surfaceSunken : c.surface,
      })}
    >
      <BrandMark name={brand.name} slug={brand.slug} logoUrl={brand.logoUrl} size={40} />

      <Text variant="subheading" numberOfLines={1}>
        {brand.name}
      </Text>

      {bestRate > 0 ? (
        <Text variant="caption" color="tertiaryText">
          up to ₦{bestRate.toLocaleString('en-NG')}
        </Text>
      ) : (
        <Text variant="caption" color="quaternaryText">
          Rate on request
        </Text>
      )}
    </Pressable>
  );
}

/** ISO country code → regional-indicator flag emoji. */
function flagEmoji(countryCode: string): string {
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '🏳️';
  const base = 0x1f1e6;
  return String.fromCodePoint(
    ...[...code].map((ch) => base + ch.charCodeAt(0) - 65)
  );
}

/**
 * Leading mark for country rows — same 36pt well size as Sell Crypto coin glyphs.
 */
function CountryFlag({ code }: { code: string }) {
  const { c, radius } = useTheme();
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: radius.card,
        backgroundColor: c.surfaceSunken,
        borderWidth: 1,
        borderColor: c.hairline,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Text style={{ fontSize: 20, lineHeight: 24 }}>{flagEmoji(code)}</Text>
    </View>
  );
}
