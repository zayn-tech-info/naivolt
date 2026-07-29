/**
 * Gift cards — sell a card for naira.
 *
 * Replaces Sell as the second action on the home bar. Two steps: pick the brand,
 * then enter the card. The split is what keeps the first screen a clean grid of
 * recognisable logos — people find their card by its logo, not by reading a list
 * of names, so the grid is image-led and the text is secondary.
 *
 * The payout figure is computed and shown live as the denomination is typed,
 * before anything is submitted. A gift card sale is a manual-review flow — an
 * admin verifies the card and pays out — so the one thing the user must be able
 * to check up front is what they'll get. Leaving that to appear after submission
 * is how a flow gets abandoned.
 *
 * The submit path (multipart XHR to /gift-cards/transactions, with the proof
 * screenshot) is carried over unchanged from the previous version. It works
 * against the live backend and is not what this redesign is touching.
 */

import { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
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
import { api } from '@/services/api';
import { config } from '@/constants/config';
import { useAuthStore } from '@/store/authStore';
import { reportError } from '@/services/monitoring';

interface CountryRate {
  code: string;
  name: string;
  currency: string;
  ratePerUnit: number;
}

interface GiftCardCategory {
  _id: string;
  name: string;
  slug: string;
  emoji: string;
  imageUrl?: string | null;
  countries: CountryRate[];
}

interface CategoriesResponse {
  data?: GiftCardCategory[];
}

/**
 * Brand logos by slug. The backend may send `imageUrl`, which wins; this is the
 * fallback for categories that don't carry one.
 *
 * These are remote, unlike the coin marks which are bundled. That's a deliberate
 * difference: the brand list is server-driven and open-ended, so bundling it
 * would mean shipping an app update to add a card type. A brand logo failing to
 * load is also recoverable — the lettermark below reads fine — whereas a missing
 * coin mark sits on the screen where someone picks which chain to send on.
 */
const BRAND_IMAGE: Record<string, string> = {
  amazon: 'https://logo.clearbit.com/amazon.com',
  'amazon-gift-card': 'https://logo.clearbit.com/amazon.com',
  apple: 'https://logo.clearbit.com/apple.com',
  itunes: 'https://logo.clearbit.com/apple.com',
  'apple-itunes': 'https://logo.clearbit.com/apple.com',
  'google-play': 'https://logo.clearbit.com/play.google.com',
  google: 'https://logo.clearbit.com/google.com',
  steam: 'https://logo.clearbit.com/steampowered.com',
  netflix: 'https://logo.clearbit.com/netflix.com',
  spotify: 'https://logo.clearbit.com/spotify.com',
  playstation: 'https://logo.clearbit.com/playstation.com',
  'playstation-network': 'https://logo.clearbit.com/playstation.com',
  xbox: 'https://logo.clearbit.com/xbox.com',
  'xbox-live': 'https://logo.clearbit.com/xbox.com',
  nintendo: 'https://logo.clearbit.com/nintendo.com',
  ebay: 'https://logo.clearbit.com/ebay.com',
  walmart: 'https://logo.clearbit.com/walmart.com',
  target: 'https://logo.clearbit.com/target.com',
  visa: 'https://logo.clearbit.com/visa.com',
  mastercard: 'https://logo.clearbit.com/mastercard.com',
  vanilla: 'https://logo.clearbit.com/vanillagift.com',
};

const BRAND_COLOR: Record<string, string> = {
  amazon: '#FF9900',
  apple: '#A2AAAD',
  itunes: '#FC3C44',
  'google-play': '#34A853',
  google: '#4285F4',
  steam: '#66C0F4',
  netflix: '#E50914',
  spotify: '#1DB954',
  playstation: '#0070D1',
  xbox: '#107C10',
  nintendo: '#E4000F',
  ebay: '#E53238',
  walmart: '#0071CE',
  visa: '#1A1F71',
  mastercard: '#EB001B',
};

function brandImage(cat: GiftCardCategory): string | null {
  if (cat.imageUrl) return cat.imageUrl;
  const slug = cat.slug?.toLowerCase() ?? '';
  const name = cat.name?.toLowerCase() ?? '';
  return BRAND_IMAGE[slug] ?? BRAND_IMAGE[name] ?? null;
}

function brandColor(cat: GiftCardCategory): string {
  return BRAND_COLOR[cat.slug?.toLowerCase() ?? ''] ?? '#6366F1';
}

/** Common face values, offered as chips so the usual case is one tap. */
const DENOMINATIONS = [25, 50, 100, 200];

export default function GiftCardsScreen() {
  const router = useRouter();
  const { c, space, radius } = useTheme();
  const { show } = useToast();

  const [step, setStep] = useState<'select' | 'details' | 'done'>('select');
  const [category, setCategory] = useState<GiftCardCategory | null>(null);
  const [country, setCountry] = useState<CountryRate | null>(null);
  const [denomination, setDenomination] = useState('');
  const [cardCode, setCardCode] = useState('');
  const [cardPin, setCardPin] = useState('');
  const [proofImage, setProofImage] = useState<{ uri: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [countryOpen, setCountryOpen] = useState(false);

  const { data: categories = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['giftCardCategories'],
    queryFn: async () => {
      const res = await api.get<CategoriesResponse>('/gift-cards/categories');
      return res.data?.data ?? [];
    },
  });

  const faceValue = useMemo(() => parseFloat(denomination) || 0, [denomination]);
  const payout = useMemo(
    () => (country && faceValue > 0 ? Math.round(faceValue * country.ratePerUnit) : 0),
    [country, faceValue]
  );

  const canSubmit =
    !!category && !!country && faceValue > 0 && cardCode.trim().length > 0 && !!proofImage;

  const selectCategory = useCallback((cat: GiftCardCategory) => {
    setCategory(cat);
    // Single-country cards have no choice to make.
    setCountry(cat.countries.length === 1 ? cat.countries[0] : null);
    setStep('details');
  }, []);

  const goBack = useCallback(() => {
    if (step === 'details') {
      setStep('select');
      setCategory(null);
      setCountry(null);
      setDenomination('');
      setCardCode('');
      setCardPin('');
      setProofImage(null);
      setSubmitError('');
    } else {
      router.back();
    }
  }, [step, router]);

  const pickImage = useCallback(async () => {
    try {
      const ImagePicker = await import('expo-image-picker');
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        show('Allow photo access to upload the card image', 'warning');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setProofImage({ uri: result.assets[0].uri });
      }
    } catch {
      show('Could not open your photo library', 'negative');
    }
  }, [show]);

  const submit = useCallback(async () => {
    if (!canSubmit || submitting) return;
    setSubmitError('');
    setSubmitting(true);

    try {
      const token = useAuthStore.getState().token;

      const formData = new FormData();
      formData.append('categoryId', category!._id);
      formData.append('country', country!.code);
      formData.append('denomination', String(faceValue));
      formData.append('cardCode', cardCode.trim());
      if (cardPin.trim()) formData.append('cardPin', cardPin.trim());

      if (proofImage?.uri) {
        const filename = proofImage.uri.split('/').pop() || 'proof.jpg';
        const match = /\.(jpe?g|png|webp)$/i.exec(filename);
        const mime = match ? `image/${match[1].toLowerCase()}` : 'image/jpeg';
        formData.append('proofImage', {
          uri: proofImage.uri,
          name: filename,
          type: mime,
        } as unknown as Blob);
      }

      // XHR rather than axios: React Native's fetch/axios multipart handling
      // drops the file on some Android builds. Carried over unchanged.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${config.apiUrl}/api/v1/gift-cards/transactions`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            let msg = 'Could not submit the card. Try again.';
            try {
              msg = JSON.parse(xhr.responseText)?.message ?? msg;
            } catch {}
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error('Cannot reach Naivolt. Check your connection.'));
        xhr.ontimeout = () => reject(new Error('That took too long. Try again.'));
        xhr.timeout = 30000;
        xhr.send(formData);
      });

      setStep('done');
    } catch (err) {
      const message = (err as { message?: string })?.message ?? 'Could not submit the card.';
      setSubmitError(message);
      reportError(err, { flow: 'giftCardSubmit', categorySlug: category?.slug });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, submitting, category, country, faceValue, cardCode, cardPin, proofImage]);

  // ── Submitted ───────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <Screen edges={['top']} scroll={false}>
        <ScreenHeader />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.comfy }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: c.positiveDim,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="checkmark" size={30} color={c.positive} />
          </View>

          <Text variant="title" align="center">
            Card submitted
          </Text>
          <Money value={payout} variant="figure" />
          <Text
            variant="bodySmall"
            color="secondaryText"
            align="center"
            style={{ maxWidth: 300 }}
          >
            We’re verifying your {category?.name} card now. Once it clears, this lands in your bank
            account and you’ll get a notification.
          </Text>

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
  if (step === 'select') {
    return (
      <Screen edges={['top']} tabBarClearance>
        <ScreenHeader title="Sell a gift card" onBack={goBack} />

        {isLoading ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.base, marginTop: space.comfy }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} width="47%" height={112} radius={radius.tile} />
            ))}
          </View>
        ) : isError ? (
          <View style={{ marginTop: space.major }}>
            <EmptyState
              icon="cloud-offline-outline"
              title="Couldn’t load card types"
              body="Check your connection and try again."
              actionLabel="Retry"
              onAction={() => refetch()}
            />
          </View>
        ) : categories.length === 0 ? (
          <View style={{ marginTop: space.major }}>
            <EmptyState
              icon="gift-outline"
              title="No cards available right now"
              body="Card types are added by Naivolt. Check back shortly."
            />
          </View>
        ) : (
          <>
            <Text variant="bodySmall" color="tertiaryText" style={{ marginBottom: space.comfy }}>
              Pick the card you want to sell. Rates are per dollar of face value.
            </Text>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.base }}>
              {categories.map((cat, i) => (
                <Stagger key={cat._id} index={Math.min(i, 5)} style={{ width: '47.5%' }}>
                  <BrandTile category={cat} onPress={() => selectCategory(cat)} />
                </Stagger>
              ))}
            </View>
          </>
        )}
      </Screen>
    );
  }

  // ── Step 2: card details ────────────────────────────────────────────
  const rateLabel = country
    ? `₦${country.ratePerUnit.toLocaleString('en-NG')} per ${country.currency}`
    : 'Select a country to see the rate';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen edges={['top']}>
        <ScreenHeader title={category?.name ?? 'Gift card'} onBack={goBack} />

        {/* Payout preview leads: it's what the user is here to find out. */}
        <Stagger index={0}>
          <Surface level={1} style={{ alignItems: 'center', gap: space.tight }}>
            <Text variant="eyebrow" color="tertiaryText">
              You get
            </Text>
            {payout > 0 ? (
              <Money value={payout} variant="figure" />
            ) : (
              <Text variant="figure" color="quaternaryText">
                ₦0
              </Text>
            )}
            <Text variant="caption" color="tertiaryText">
              {rateLabel}
            </Text>
          </Surface>
        </Stagger>

        <Stagger index={1}>
          <Section title="Card country">
            {category && category.countries.length > 1 ? (
              <>
                <Surface
                  level={1}
                  radiusToken="field"
                  onPress={() => setCountryOpen((v) => !v)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}
                >
                  <Text variant="body" color={country ? 'primaryText' : 'tertiaryText'} style={{ flex: 1 }}>
                    {country ? `${country.name} · ${country.currency}` : 'Select country'}
                  </Text>
                  <Ionicons
                    name={countryOpen ? 'chevron-up' : 'chevron-down'}
                    size={17}
                    color={c.secondaryText}
                  />
                </Surface>

                {countryOpen ? (
                  <Surface level={2} padding={0} style={{ marginTop: space.snug, maxHeight: 260 }}>
                    <ScrollView>
                      {category.countries.map((option, i) => (
                        <Pressable
                          key={option.code}
                          onPress={() => {
                            setCountry(option);
                            setCountryOpen(false);
                          }}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingVertical: space.base,
                            paddingHorizontal: space.comfy,
                            ...(i === category.countries.length - 1
                              ? null
                              : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
                          }}
                        >
                          <View style={{ flex: 1 }}>
                            <Text variant="subheading">{option.name}</Text>
                            <Text variant="amountSmall" color="tertiaryText" style={{ marginTop: 2 }}>
                              ₦{option.ratePerUnit.toLocaleString('en-NG')} / {option.currency}
                            </Text>
                          </View>
                          {country?.code === option.code ? (
                            <Ionicons name="checkmark" size={17} color={c.primaryAccent} />
                          ) : null}
                        </Pressable>
                      ))}
                    </ScrollView>
                  </Surface>
                ) : null}
              </>
            ) : (
              <Surface level={1} radiusToken="field">
                <Text variant="body">
                  {country ? `${country.name} · ${country.currency}` : '—'}
                </Text>
              </Surface>
            )}
          </Section>
        </Stagger>

        <Stagger index={2}>
          <Section title="Face value">
            <View style={{ flexDirection: 'row', gap: space.snug, marginBottom: space.base }}>
              {DENOMINATIONS.map((value) => {
                const active = faceValue === value;
                return (
                  <Surface
                    key={value}
                    level={active ? 2 : 1}
                    radiusToken="chip"
                    padding={space.snug + 2}
                    onPress={() => setDenomination(String(value))}
                    style={{
                      flex: 1,
                      alignItems: 'center',
                      borderWidth: 1,
                      borderColor: active ? c.primaryAccent : 'transparent',
                    }}
                  >
                    <Text variant="amount" color={active ? 'primaryText' : 'secondaryText'}>
                      {country?.currency === 'USD' || !country ? '$' : ''}
                      {value}
                    </Text>
                  </Surface>
                );
              })}
            </View>

            <Input
              value={denomination}
              onChangeText={setDenomination}
              placeholder="Or enter another amount"
              keyboardType="decimal-pad"
              mono
              prefix={country?.currency ?? '$'}
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
            <Input
              label="PIN (if your card has one)"
              value={cardPin}
              onChangeText={setCardPin}
              placeholder="Optional"
              autoCapitalize="characters"
              autoCorrect={false}
              mono
            />
          </Section>
        </Stagger>

        <Stagger index={4}>
          <Section title="Card image">
            {proofImage ? (
              <Surface level={1} style={{ gap: space.base }}>
                <Image
                  source={{ uri: proofImage.uri }}
                  style={{ width: '100%', height: 180, borderRadius: radius.tile }}
                  contentFit="cover"
                />
                <View style={{ flexDirection: 'row', gap: space.snug }}>
                  <Button title="Replace" variant="secondary" size="sm" onPress={pickImage} />
                  <Button
                    title="Remove"
                    variant="ghost"
                    size="sm"
                    onPress={() => setProofImage(null)}
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
                <Ionicons name="image-outline" size={24} color={c.tertiaryText} />
                <Text variant="subheading">Add a photo of the card</Text>
                <Text variant="caption" color="tertiaryText" align="center" style={{ maxWidth: 240 }}>
                  Clear enough to read the code. This is what our team verifies against.
                </Text>
              </Surface>
            )}
          </Section>
        </Stagger>

        {submitError ? (
          <Surface
            level={1}
            accentEdge={c.negative}
            style={{ marginTop: space.comfy, flexDirection: 'row', gap: space.snug }}
          >
            <Ionicons name="alert-circle" size={17} color={c.negative} />
            <Text variant="bodySmall" color="negative" style={{ flex: 1 }}>
              {submitError}
            </Text>
          </Surface>
        ) : null}

        <Button
          title={payout > 0 ? `Sell for ₦${payout.toLocaleString('en-NG')}` : 'Sell card'}
          onPress={submit}
          disabled={!canSubmit}
          loading={submitting}
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
      </Screen>
    </KeyboardAvoidingView>
  );
}

/** One brand in the selection grid. Logo-led, since that's how people scan. */
function BrandTile({
  category,
  onPress,
}: {
  category: GiftCardCategory;
  onPress: () => void;
}) {
  const { c, space, radius } = useTheme();
  const [failed, setFailed] = useState(false);
  const uri = brandImage(category);
  const tint = brandColor(category);

  // Best rate across countries — the headline number for the tile.
  const bestRate = category.countries.length
    ? Math.max(...category.countries.map((x) => x.ratePerUnit))
    : 0;

  return (
    <Surface
      level={1}
      radiusToken="tile"
      onPress={onPress}
      padding={space.comfy}
      style={{ gap: space.snug, minHeight: 112 }}
      accessibilityLabel={`${category.name}, up to ${bestRate} naira per unit`}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.chip,
          backgroundColor: failed || !uri ? `${tint}22` : '#FFFFFF',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {uri && !failed ? (
          <Image
            source={{ uri }}
            style={{ width: 40, height: 40 }}
            contentFit="contain"
            transition={120}
            onError={() => setFailed(true)}
          />
        ) : (
          <Text variant="subheading" color={tint} style={{ fontSize: 18 }}>
            {category.emoji || category.name.slice(0, 1).toUpperCase()}
          </Text>
        )}
      </View>

      <Text variant="subheading" numberOfLines={1}>
        {category.name}
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
