package com.kirandp.advertisementapp.video

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

class AndroidVideoEncoderModule(
  reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "AndroidVideoEncoder"

  @ReactMethod
  fun encodePngSequence(
    frameDirUri: String,
    outputUri: String,
    fpsDouble: Double,
    bitRateDouble: Double,
    promise: Promise
  ) {
    Thread {
      try {
        val fps = max(1, fpsDouble.toInt())
        val bitRate = max(500_000, bitRateDouble.toInt())

        val frameDir = File(toFilePath(frameDirUri))
        if (!frameDir.exists() || !frameDir.isDirectory) {
          throw IllegalArgumentException("Frame directory not found: $frameDirUri")
        }

        val frames = frameDir
          .listFiles { file ->
            file.isFile &&
              file.name.lowercase().endsWith(".png") &&
              file.name.startsWith("frame_")
          }
          ?.sortedBy { it.name }
          ?: emptyList()

        if (frames.isEmpty()) {
          throw IllegalArgumentException("No PNG frames found in: $frameDirUri")
        }

        val outputPath = toFilePath(outputUri)
        val outputFile = File(outputPath)
        outputFile.parentFile?.mkdirs()
        if (outputFile.exists()) outputFile.delete()

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(frames.first().absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
          throw IllegalArgumentException("Could not read first frame size.")
        }

        // H.264 encoders usually require even dimensions.
        val videoWidth = bounds.outWidth - (bounds.outWidth % 2)
        val videoHeight = bounds.outHeight - (bounds.outHeight % 2)

        encodeFrames(frames, outputPath, videoWidth, videoHeight, fps, bitRate)
        promise.resolve(if (outputUri.startsWith("file://")) outputUri else "file://$outputPath")
      } catch (t: Throwable) {
        promise.reject("VIDEO_ENCODE_FAILED", t.message, t)
      }
    }.start()
  }

  private fun encodeFrames(
    frames: List<File>,
    outputPath: String,
    width: Int,
    height: Int,
    fps: Int,
    bitRate: Int
  ) {
    val mime = MediaFormat.MIMETYPE_VIDEO_AVC
    val codecInfo = selectCodec(mime)
      ?: throw IllegalStateException("No H.264 encoder found on this Android device.")
    val colorFormat = selectColorFormat(codecInfo, mime)
    val semiPlanar = isSemiPlanar(colorFormat)

    val format = MediaFormat.createVideoFormat(mime, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, colorFormat)
      setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }

    val encoder = MediaCodec.createByCodecName(codecInfo.name)
    val bufferInfo = MediaCodec.BufferInfo()
    var muxer: MediaMuxer? = null
    var trackIndex = -1
    var muxerStarted = false

    try {
      encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      encoder.start()
      muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

      var frameIndex = 0
      var inputDone = false
      var encoderDone = false

      while (!encoderDone) {
        if (!inputDone) {
          val inputBufferIndex = encoder.dequeueInputBuffer(10_000)
          if (inputBufferIndex >= 0) {
            val inputBuffer = encoder.getInputBuffer(inputBufferIndex)
              ?: throw IllegalStateException("Encoder input buffer is null.")
            inputBuffer.clear()

            if (frameIndex < frames.size) {
              val bitmap = decodeScaledBitmap(frames[frameIndex], width, height)
              val yuv = bitmapToYuv420(bitmap, width, height, semiPlanar)
              bitmap.recycle()

              inputBuffer.put(yuv)
              val presentationTimeUs = computePresentationTimeUs(frameIndex, fps)
              encoder.queueInputBuffer(
                inputBufferIndex,
                0,
                yuv.size,
                presentationTimeUs,
                0
              )
              frameIndex += 1
            } else {
              encoder.queueInputBuffer(
                inputBufferIndex,
                0,
                0,
                computePresentationTimeUs(frameIndex, fps),
                MediaCodec.BUFFER_FLAG_END_OF_STREAM
              )
              inputDone = true
            }
          }
        }

        var outputAvailable = true
        while (outputAvailable) {
          when (val outputBufferIndex = encoder.dequeueOutputBuffer(bufferInfo, 10_000)) {
            MediaCodec.INFO_TRY_AGAIN_LATER -> {
              outputAvailable = false
            }

            MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              if (muxerStarted) {
                throw IllegalStateException("Encoder output format changed twice.")
              }
              val newFormat = encoder.outputFormat
              trackIndex = muxer.addTrack(newFormat)
              muxer.start()
              muxerStarted = true
            }

            MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> {
              // Deprecated on modern Android. Safe to ignore.
            }

            else -> {
              if (outputBufferIndex < 0) continue

              val encodedData: ByteBuffer = encoder.getOutputBuffer(outputBufferIndex)
                ?: throw IllegalStateException("Encoder output buffer is null.")

              if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                bufferInfo.size = 0
              }

              if (bufferInfo.size > 0) {
                if (!muxerStarted) {
                  throw IllegalStateException("Muxer has not started.")
                }

                encodedData.position(bufferInfo.offset)
                encodedData.limit(bufferInfo.offset + bufferInfo.size)
                muxer.writeSampleData(trackIndex, encodedData, bufferInfo)
              }

              encoder.releaseOutputBuffer(outputBufferIndex, false)

              if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                encoderDone = true
                outputAvailable = false
              }
            }
          }
        }
      }
    } finally {
      try {
        encoder.stop()
      } catch (_: Throwable) {
      }
      try {
        encoder.release()
      } catch (_: Throwable) {
      }
      try {
        muxer?.stop()
      } catch (_: Throwable) {
      }
      try {
        muxer?.release()
      } catch (_: Throwable) {
      }
    }
  }

  private fun selectCodec(mimeType: String): MediaCodecInfo? {
    val codecList = MediaCodecList(MediaCodecList.REGULAR_CODECS)
    return codecList.codecInfos.firstOrNull { codecInfo ->
      codecInfo.isEncoder && codecInfo.supportedTypes.any { it.equals(mimeType, ignoreCase = true) }
    }
  }

  private fun selectColorFormat(codecInfo: MediaCodecInfo, mimeType: String): Int {
    val capabilities = codecInfo.getCapabilitiesForType(mimeType)
    val preferred = listOf(
      MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar,
      MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Planar,
      MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
    )

    preferred.firstOrNull { wanted ->
      capabilities.colorFormats.any { it == wanted }
    }?.let { return it }

    throw IllegalStateException(
      "No supported YUV420 color format found for encoder: ${codecInfo.name}"
    )
  }

  private fun isSemiPlanar(colorFormat: Int): Boolean {
    return colorFormat == MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar ||
      colorFormat == MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
  }

  private fun decodeScaledBitmap(file: File, width: Int, height: Int): Bitmap {
    val src = BitmapFactory.decodeFile(file.absolutePath)
      ?: throw IllegalArgumentException("Could not decode frame: ${file.name}")

    val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(output)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG)

    canvas.drawColor(Color.BLACK)
    val srcRect = Rect(0, 0, src.width, src.height)
    val dstRect = Rect(0, 0, width, height)
    canvas.drawBitmap(src, srcRect, dstRect, paint)
    src.recycle()
    return output
  }

  private fun bitmapToYuv420(
    bitmap: Bitmap,
    width: Int,
    height: Int,
    semiPlanar: Boolean
  ): ByteArray {
    val argb = IntArray(width * height)
    bitmap.getPixels(argb, 0, width, 0, 0, width, height)

    val frameSize = width * height
    val qFrameSize = frameSize / 4
    val yuv = ByteArray(frameSize + frameSize / 2)

    var yIndex = 0
    var uvIndex = frameSize
    var uIndex = frameSize
    var vIndex = frameSize + qFrameSize

    for (j in 0 until height) {
      for (i in 0 until width) {
        val c = argb[j * width + i]
        val r = (c shr 16) and 0xff
        val g = (c shr 8) and 0xff
        val b = c and 0xff

        val y = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
        val u = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
        val v = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128

        yuv[yIndex++] = clampToByte(y)

        if (j % 2 == 0 && i % 2 == 0) {
          if (semiPlanar) {
            // NV12: Y plane, then interleaved U/V.
            yuv[uvIndex++] = clampToByte(u)
            yuv[uvIndex++] = clampToByte(v)
          } else {
            // I420: Y plane, U plane, V plane.
            yuv[uIndex++] = clampToByte(u)
            yuv[vIndex++] = clampToByte(v)
          }
        }
      }
    }

    return yuv
  }

  private fun clampToByte(value: Int): Byte {
    return min(255, max(0, value)).toByte()
  }

  private fun computePresentationTimeUs(frameIndex: Int, fps: Int): Long {
    return 132L + frameIndex * 1_000_000L / fps
  }

  private fun toFilePath(uriOrPath: String): String {
    return when {
      uriOrPath.startsWith("file://") -> Uri.parse(uriOrPath).path ?: uriOrPath.removePrefix("file://")
      else -> uriOrPath
    }
  }
}
